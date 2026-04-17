(function(){
    let receiverID;
    const socket = io();
    let peerConnection;
    let dataChannel;
    let fileCount = 0;
    let activeTransfers = new Map();

    // Loader intervals
    let _rainInterval = null;
    let _pulseInterval = null;

    // ── Session state ──────────────────────────────────────────
    let passphrase    = '';
    let expiryMs      = 0;
    let expiryTimer   = null;
    let sessionActive = false;
    let chatOpen      = false;
    let unreadCount   = 0;

    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    function generateID(){
        const seg = () => Math.floor(Math.random() * 900) + 100;
        return `${seg()}-${seg()}-${seg()}`;
    }

    // ── Toast ──────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
            <span>${message}</span>
        `;
        document.getElementById('toast-container').appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideInRight 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ── Helpers ────────────────────────────────────────────────
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
    }

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return '…';
        if (seconds < 60)   return Math.round(seconds) + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (Math.round(seconds % 60)) + 's';
        return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    }

    function formatCountdown(ms) {
        if (ms <= 0) return '00:00:00';
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return [h,m,s].map(v => String(v).padStart(2,'0')).join(':');
    }

    function updateFileCount() {
        const el = document.getElementById('file-count');
        if (el) el.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }

    function getFileIcon(fileName) {
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const iconMap = {
            pdf:'fa-file-pdf', doc:'fa-file-word', docx:'fa-file-word',
            xls:'fa-file-excel', xlsx:'fa-file-excel', ppt:'fa-file-powerpoint', pptx:'fa-file-powerpoint',
            jpg:'fa-file-image', jpeg:'fa-file-image', png:'fa-file-image', gif:'fa-file-image', webp:'fa-file-image', svg:'fa-file-image',
            zip:'fa-file-archive', rar:'fa-file-archive', '7z':'fa-file-archive', tar:'fa-file-archive', gz:'fa-file-archive',
            mp3:'fa-file-audio', wav:'fa-file-audio', flac:'fa-file-audio', aac:'fa-file-audio', ogg:'fa-file-audio',
            mp4:'fa-file-video', avi:'fa-file-video', mkv:'fa-file-video', mov:'fa-file-video', webm:'fa-file-video',
            txt:'fa-file-alt', md:'fa-file-alt', json:'fa-file-code', js:'fa-file-code', ts:'fa-file-code',
            html:'fa-file-code', css:'fa-file-code', py:'fa-file-code', java:'fa-file-code',
        };
        return iconMap[ext] || 'fa-file';
    }

    function escapeHtml(t) {
        return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Expiry countdown tick ──────────────────────────────────
    function startExpiryCountdown() {
        const tick = () => {
            const remaining = expiryMs - Date.now();
            const el = document.getElementById('expiry-countdown');
            if (el) {
                el.textContent = formatCountdown(remaining);
                el.style.color = remaining < 300000 ? '#ff4444' : remaining < 900000 ? '#f59e0b' : '#40c21c';
            }
            if (remaining <= 0) { clearInterval(expiryTimer); burnSession('Session expired — link self-destructed.'); }
        };
        tick();
        expiryTimer = setInterval(tick, 1000);
    }

    function burnSession(reason) {
        clearInterval(expiryTimer);
        sessionActive = false;
        showToast(reason || 'Session terminated.', 'error');
        setTimeout(() => location.reload(), 2500);
    }

    // ── Loading Screen ─────────────────────────────────────────
    function initLoader(roomID) {
        const screen   = document.getElementById('loader-screen');
        const canvas   = document.getElementById('loader-rain');
        const fillEl   = document.getElementById('loader-fill');
        const statusEl = document.getElementById('loader-status');
        const dotsEl   = document.getElementById('loader-dots');
        const roomEl   = document.getElementById('loader-room-id');
        if (roomEl) roomEl.textContent = roomID;
        const dots    = Array.from(dotsEl.children);
        const total   = dots.length;
        const palette = ['#40c21c','#57d42e','#84f163','#48ecc8','#1eff00','#057a0f'];
        const msgs    = ['room created','broadcasting room id','awaiting peer','listening for receiver','standing by','waiting for receiver'];
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                const ctx = canvas.getContext('2d');
                canvas.width  = screen.offsetWidth  || 800;
                canvas.height = screen.offsetHeight || 600;
                const cols  = Math.floor(canvas.width / 18);
                const drops = Array.from({length: cols}, () => Math.random() * -60);
                _rainInterval = setInterval(function() {
                    ctx.fillStyle = 'rgba(6,26,8,0.15)';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    for (let i = 0; i < drops.length; i++) {
                        const bit    = Math.random() > 0.5 ? '1' : '0';
                        const bright = drops[i] * 18 > canvas.height * 0.55;
                        ctx.fillStyle   = bright ? palette[Math.floor(Math.random()*2)] : palette[2 + Math.floor(Math.random()*4)];
                        ctx.font        = (Math.random() > 0.8 ? 13 : 10) + "px 'Share Tech Mono', monospace";
                        ctx.globalAlpha = bright ? 0.15 + Math.random()*0.2 : 0.05 + Math.random()*0.12;
                        ctx.fillText(bit, i*18, drops[i]*18);
                        ctx.globalAlpha = 1;
                        if (drops[i]*18 > canvas.height && Math.random() > 0.96) drops[i] = 0;
                        drops[i] += 0.3 + Math.random()*0.35;
                    }
                }, 60);
            });
        });
        let t = 0, progress = 0, lastMsg = '';
        _pulseInterval = setInterval(function() {
            t++;
            const target = 55 + Math.sin(t * 0.05) * 7;
            progress = progress < target ? Math.min(progress + 0.5, target) : Math.max(progress - 0.15, target);
            fillEl.style.width = progress + '%';
            const lit = Math.floor((progress / 100) * total);
            dots.forEach((d, i) => { d.className = 'ldot' + (i < lit ? ' lit' : '') + (i === lit ? ' active' : ''); });
            const idx = Math.floor(t / 30) % msgs.length;
            if (msgs[idx] !== lastMsg) {
                statusEl.style.opacity = '0';
                setTimeout(function() { statusEl.textContent = msgs[idx]; statusEl.style.opacity = '1'; lastMsg = msgs[idx]; }, 300);
            }
        }, 100);
    }

    function finishLoader(onComplete) {
        clearInterval(_rainInterval);
        clearInterval(_pulseInterval);
        const fillEl   = document.getElementById('loader-fill');
        const statusEl = document.getElementById('loader-status');
        const dots     = Array.from(document.getElementById('loader-dots').children);
        const total    = dots.length;
        statusEl.style.opacity = '0';
        setTimeout(function() { statusEl.textContent = 'connected'; statusEl.style.opacity = '1'; }, 300);
        let p = parseFloat(fillEl.style.width) || 0;
        const sweep = setInterval(function() {
            p = Math.min(p + 3, 100);
            fillEl.style.width = p + '%';
            const lit = Math.floor((p / 100) * total);
            dots.forEach((d, i) => { d.className = 'ldot' + (i < lit ? ' lit' : '') + (i === lit ? ' active' : ''); });
            if (p >= 100) { clearInterval(sweep); setTimeout(onComplete, 500); }
        }, 18);
    }

    // ── Passphrase Accordion ───────────────────────────────────
    window.togglePassphrase = function() {
        const btn  = document.getElementById('mk-toggle-btn');
        const body = document.getElementById('mk-body');
        if (!btn || !body) return;
        const isOpen = body.classList.contains('open');
        body.classList.toggle('open', !isOpen);
        btn.classList.toggle('open', !isOpen);
        if (!isOpen) setTimeout(() => { const inp = document.getElementById('mk-input-field'); if (inp) inp.focus(); }, 320);
    };

    window.applyPassphrase = function() {
        const inp    = document.getElementById('mk-input-field');
        const btn    = document.getElementById('mk-apply-btn');
        const status = document.getElementById('mk-status-text');
        const accord = document.getElementById('master-key-panel');
        const toggle = document.getElementById('mk-toggle-btn');
        if (!inp) return;
        const val = inp.value.trim();
        if (!val) {
            if (status) { status.textContent = '⚠ Enter a passphrase first.'; status.className = 'mk-set-status err'; }
            inp.focus(); return;
        }
        passphrase = val;
        if (btn) { btn.innerHTML = '<i class="fas fa-check-circle"></i> Applied!'; btn.classList.add('success'); setTimeout(() => { btn.innerHTML = '<i class="fas fa-check"></i> Apply'; btn.classList.remove('success'); }, 2200); }
        if (status) { status.textContent = '✓ Passphrase set — receiver will be prompted on connect.'; status.className = 'mk-set-status ok'; }
        if (accord) accord.classList.add('applied');
        if (toggle) toggle.classList.add('applied');
        setTimeout(() => { const body = document.getElementById('mk-body'); if (body) body.classList.remove('open'); if (toggle) toggle.classList.remove('open'); }, 1800);
    };

    window.clearPassphrase = function() {
        passphrase = '';
        const inp    = document.getElementById('mk-input-field');
        const status = document.getElementById('mk-status-text');
        const accord = document.getElementById('master-key-panel');
        const toggle = document.getElementById('mk-toggle-btn');
        if (inp)    inp.value = '';
        if (status) { status.textContent = 'Passphrase cleared.'; status.className = 'mk-set-status'; }
        if (accord) accord.classList.remove('applied');
        if (toggle) toggle.classList.remove('applied');
        setTimeout(() => { if (status) status.textContent = ''; }, 2000);
    };

    document.addEventListener('DOMContentLoaded', function() {
        const inp = document.getElementById('mk-input-field');
        if (inp) inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') window.applyPassphrase(); });
    });

    // ── Create Room ────────────────────────────────────────────
    document.querySelector("#sender-start-con-btn").addEventListener("click", function(){
        const joinID = generateID();
        const expiryChoice = document.querySelector('input[name="expiry"]:checked');
        const expiryHours  = expiryChoice ? parseInt(expiryChoice.value) : 24;
        expiryMs = Date.now() + expiryHours * 3600 * 1000;
        const expiryLabel = expiryHours === 1 ? '1 hour' : expiryHours === 24 ? '24 hours' : '7 days';

        document.querySelector("#join-id").innerHTML = `
            <b><i class="fas fa-key"></i> Room ID</b>
            <span onclick="copyToClipboard(this.textContent)">${joinID}</span>
            <p style="color: var(--text-secondary); font-size: 0.75rem; margin-top: 0.5rem;">
                <i class="fas fa-copy"></i> Click to copy
            </p>
        `;

        const expBadge = document.getElementById('expiry-badge');
        if (expBadge) { expBadge.style.display = 'flex'; document.getElementById('expiry-label').textContent = `Self-destructs in ${expiryLabel}`; }

        socket.emit("sender-join", { uid: joinID, masterKey: passphrase, expiryMs });
        showToast(`Room created! Expires in ${expiryLabel}.${passphrase ? ' Passphrase auth enabled.' : ''}`, 'success');

        const si = document.querySelector('.status-indicator');
        if (si) { si.classList.remove('connected','disconnected'); si.classList.add('waiting'); }
    });

    window.copyToClipboard = function(text) {
        navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
    };

    // ── Socket Events ──────────────────────────────────────────
    socket.on("init", function(uid){
        receiverID = uid;
        sessionActive = true;
        peerConnection = new RTCPeerConnection(configuration);

        dataChannel = peerConnection.createDataChannel("fileTransfer", { ordered: true });
        dataChannel.bufferedAmountLowThreshold = 262144; // 256KB

        dataChannel.onopen = function(){
            document.getElementById('connection-text').textContent = 'Connected to receiver';
            const si = document.querySelector('.status-indicator');
            if (si) { si.classList.remove('waiting','disconnected'); si.classList.add('connected'); }
            showToast('Receiver connected! You can now share files.', 'success');
            dataChannel.send(JSON.stringify({ type: 'session-meta', masterKey: passphrase, expiryMs, expiryLabel: getExpiryLabel() }));
            startExpiryCountdown();
        };

        dataChannel.onmessage = function(event) {
            if (typeof event.data === 'string') {
                const msg = JSON.parse(event.data);
                if (msg.type === 'chat') appendChatMessage(msg.text, 'them', msg.alias || 'Receiver');
            }
        };

        dataChannel.onbufferedamountlow = function(){
            activeTransfers.forEach(t => { if (t.paused && t.resume) t.resume(); });
        };

        dataChannel.onclose = function(){
            document.getElementById('connection-text').textContent = 'Receiver disconnected';
            const si = document.querySelector('.status-indicator');
            if (si) { si.classList.remove('waiting','connected'); si.classList.add('disconnected'); }
            showToast('Receiver disconnected.', 'error');
        };

        peerConnection.onicecandidate = function(event){
            if (event.candidate) socket.emit("candidate", { candidate: event.candidate, uid: receiverID });
        };

        peerConnection.createOffer()
            .then(offer => peerConnection.setLocalDescription(offer))
            .then(() => socket.emit("offer", { offer: peerConnection.localDescription, uid: receiverID }));

        document.querySelector(".join-screen").classList.remove("active");
        document.querySelector(".fs-screen").classList.add("active");
    });

    function getExpiryLabel() {
        const remaining = expiryMs - Date.now();
        if (remaining > 20 * 3600 * 1000) return '7 days';
        if (remaining > 2  * 3600 * 1000) return '24 hours';
        return '1 hour';
    }

    socket.on("answer", data => peerConnection.setRemoteDescription(data.answer));
    socket.on("candidate", data => peerConnection.addIceCandidate(data.candidate));

    // ── Drag & Drop (files + folders) ─────────────────────────
    const dropArea  = document.getElementById('drop-area');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');

    ['dragenter','dragover','dragleave','drop'].forEach(ev =>
        dropArea.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, false));
    ['dragenter','dragover'].forEach(ev =>
        dropArea.addEventListener(ev, () => dropArea.classList.add('dragover'), false));
    ['dragleave','drop'].forEach(ev =>
        dropArea.addEventListener(ev, () => dropArea.classList.remove('dragover'), false));

    dropArea.addEventListener('drop', async function(e) {
        if (!dataChannel || dataChannel.readyState !== 'open') { showToast('No receiver connected yet.', 'error'); return; }
        const items = Array.from(e.dataTransfer.items || []);
        const hasDirectories = items.some(item => {
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            return entry && entry.isDirectory;
        });

        if (hasDirectories) {
            // Folder drop — traverse directory tree
            for (const item of items) {
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (entry) await traverseEntry(entry, '');
            }
        } else {
            // Plain files
            const files = Array.from(e.dataTransfer.files);
            files.forEach(f => sendFile(f, f.name));
        }
    }, false);

    async function traverseEntry(entry, basePath) {
        if (entry.isFile) {
            return new Promise(resolve => {
                entry.file(file => {
                    const relPath = basePath ? basePath + '/' + entry.name : entry.name;
                    sendFile(file, relPath);
                    resolve();
                }, resolve);
            });
        } else if (entry.isDirectory) {
            const dirPath = basePath ? basePath + '/' + entry.name : entry.name;
            const reader  = entry.createReader();
            await new Promise(resolve => {
                function readBatch() {
                    reader.readEntries(async function(entries) {
                        if (!entries.length) { resolve(); return; }
                        for (const e of entries) await traverseEntry(e, dirPath);
                        readBatch(); // read next batch (browsers limit to 100 at a time)
                    }, resolve);
                }
                readBatch();
            });
        }
    }

    // File input — reset value after use so same file can be re-selected
    fileInput.addEventListener("change", function(e) {
        const files = Array.from(e.target.files);
        if (!dataChannel || dataChannel.readyState !== 'open') { showToast('No receiver connected yet.', 'error'); fileInput.value = ''; return; }
        files.forEach(f => sendFile(f, f.name));
        fileInput.value = ''; // reset so same file triggers change again
    });

    if (folderInput) {
        folderInput.addEventListener("change", function(e) {
            const files = Array.from(e.target.files);
            if (!dataChannel || dataChannel.readyState !== 'open') { showToast('No receiver connected yet.', 'error'); folderInput.value = ''; return; }
            files.forEach(f => sendFile(f, f.webkitRelativePath || f.name));
            folderInput.value = '';
        });
    }

    // ── Send File ──────────────────────────────────────────────
    // Sequential chunk sending: one FileReader.readAsArrayBuffer at a time.
    // This is critical for large files (video) — parallel async reads cause
    // out-of-order sends and buffer overflows that crash the transfer.
    function sendFile(file, relativePath) {
        const fileId    = Date.now() + '-' + Math.floor(Math.random() * 1e9);
        const CHUNK     = 65536; // 64 KB — conservative, reliable for all file types
        let offset      = 0;
        let startTime   = Date.now();
        let lastUITime  = startTime;
        let lastUIBytes = 0;
        let isCancelled = false;
        let isPaused    = false;

        const displayName = relativePath || file.name;

        dataChannel.send(JSON.stringify({
            type: 'metadata',
            data: {
                fileId,
                fileName:     file.name,
                fileSize:     file.size,
                fileType:     file.type || 'application/octet-stream',
                relativePath: relativePath || ''
            }
        }));

        // ── Build UI row ────────────────────────────────────────
        const row = document.createElement('div');
        row.classList.add('item');
        row.dataset.fileId = fileId;
        row.style.setProperty('--pct', '0%');
        row.innerHTML = `
            <button class="remove-file-btn" title="Remove file"><i class="fas fa-times"></i></button>
            <div class="file-card-body">
                <i class="fas ${getFileIcon(file.name)} file-card-icon"></i>
                <div class="file-card-meta">
                    <div class="file-card-name" title="${escapeHtml(displayName)}" data-fullname="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                    <div class="file-card-size">${formatFileSize(file.size)}</div>
                </div>
                <div class="file-card-pct">0%</div>
            </div>
        `;
        document.querySelector('.files-list').appendChild(row);
        fileCount++;
        updateFileCount();

        row.querySelector('.remove-file-btn').addEventListener('click', function() {
            isCancelled = true;
            activeTransfers.delete(fileId);
            if (dataChannel && dataChannel.readyState === 'open') {
                dataChannel.send(JSON.stringify({ type: 'remove-file', fileId }));
            }
            row.style.transition = 'opacity 0.25s, transform 0.25s';
            row.style.opacity    = '0';
            row.style.transform  = 'translateX(16px)';
            setTimeout(() => { row.remove(); fileCount--; updateFileCount(); }, 260);
            showToast(`${file.name} removed.`, 'info');
        });

        // ── Progress helper ─────────────────────────────────────
        function refreshUI() {
            const pct = file.size > 0 ? Math.min(Math.round((offset / file.size) * 100), 100) : 0;
            row.style.setProperty('--pct', pct + '%');
            const pctEl = row.querySelector('.file-card-pct');
            if (pctEl) pctEl.textContent = pct + '%';
            lastUITime  = Date.now();
            lastUIBytes = offset;
        }

        // ── Sequential chunk sender ─────────────────────────────
        // One read at a time: onload → send → read next.
        // No while-loops, no parallel readers — prevents video corruption.
        function sendNextChunk() {
            if (isCancelled) return;

            // Back-pressure: wait for buffer to drain before sending more
            if (dataChannel.bufferedAmount > 4194304) { // 4 MB
                isPaused = true;
                activeTransfers.set(fileId, {
                    paused: true,
                    resume: () => { isPaused = false; activeTransfers.delete(fileId); sendNextChunk(); }
                });
                return;
            }

            if (offset >= file.size) {
                // ── All chunks sent ──────────────────────────────
                const dur = Math.max((Date.now() - startTime) / 1000, 0.001);
                const spd = (file.size / dur / 1024 / 1024).toFixed(2);
                dataChannel.send(JSON.stringify({ type: 'done', fileId }));

                row.style.setProperty('--pct', '100%');
                row.classList.add('send-complete');
                const pctEl = row.querySelector('.file-card-pct');
                if (pctEl) pctEl.textContent = '✓';

                showToast(`${file.name} sent — ${spd} MB/s (${formatTime(dur)})`, 'success');
                activeTransfers.delete(fileId);
                return;
            }

            // ── Read one chunk ───────────────────────────────────
            const end    = Math.min(offset + CHUNK, file.size);
            const slice  = file.slice(offset, end);
            const reader = new FileReader();

            reader.onload = function(e) {
                if (isCancelled) return;
                try {
                    dataChannel.send(e.target.result);
                    offset += e.target.result.byteLength;
                    refreshUI();
                    sendNextChunk(); // recurse — strictly sequential
                } catch (err) {
                    showToast('Transfer error: ' + (err.message || 'unknown'), 'error');
                }
            };

            reader.onerror = function() {
                showToast(`Read error on "${file.name}"`, 'error');
            };

            reader.readAsArrayBuffer(slice);
        }

        sendNextChunk();
    }

    // ── Secure Messaging ───────────────────────────────────────
    window.toggleChat = function() {
        chatOpen = !chatOpen;
        const panel = document.getElementById('chat-panel');
        const btn   = document.getElementById('chat-toggle-btn');
        if (panel) panel.classList.toggle('open', chatOpen);
        if (btn)   btn.classList.toggle('active', chatOpen);
        if (chatOpen) {
            unreadCount = 0;
            updateChatBadge();
            const input = document.getElementById('chat-input');
            if (input) input.focus();
            scrollChatToBottom();
        }
    };

    window.sendChatMessage = function() {
        const input = document.getElementById('chat-input');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        if (!dataChannel || dataChannel.readyState !== 'open') { showToast('Not connected — cannot send message.', 'error'); return; }
        dataChannel.send(JSON.stringify({ type:'chat', text, alias:'Sender' }));
        appendChatMessage(text, 'me', 'You');
        input.value = '';
    };

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'chat-input') {
            window.sendChatMessage();
        }
    });

    function updateChatBadge() {
        const badge = document.getElementById('chat-badge');
        if (!badge) return;
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
            badge.classList.add('visible');
        } else {
            badge.textContent = '';
            badge.classList.remove('visible');
        }
    }

    function appendChatMessage(text, side, alias) {
        const log = document.getElementById('chat-log');
        if (!log) return;
        const div = document.createElement('div');
        div.className = 'chat-msg ' + side;
        div.innerHTML = `
            <div class="chat-alias">${escapeHtml(alias)}</div>
            <div class="chat-bubble">${escapeHtml(text)}</div>
            <div class="chat-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
        `;
        log.appendChild(div);
        scrollChatToBottom();
        if (side === 'them' && !chatOpen) {
            unreadCount++;
            updateChatBadge();
            const btn = document.getElementById('chat-toggle-btn');
            if (btn) { btn.classList.add('pulse'); setTimeout(() => btn.classList.remove('pulse'), 2000); }
        }
    }

    function scrollChatToBottom() {
        const log = document.getElementById('chat-log');
        if (log) log.scrollTop = log.scrollHeight;
    }

    // ── Filename Tooltip ───────────────────────────────────────
    (function initTooltip() {
        const tip = document.createElement('div');
        tip.id = 'zer0-tooltip';
        document.body.appendChild(tip);

        let current = null;
        const OFFSET_X = 14, OFFSET_Y = -38;

        function show(el, x, y) {
            const name = el.getAttribute('data-fullname');
            if (!name) return;
            tip.textContent = name;
            tip.classList.add('visible');
            move(x, y);
        }
        function hide() {
            tip.classList.remove('visible');
            current = null;
        }
        function move(x, y) {
            const tw = tip.offsetWidth, th = tip.offsetHeight;
            let left = x + OFFSET_X;
            let top  = y + OFFSET_Y;
            if (left + tw > window.innerWidth  - 8) left = x - tw - OFFSET_X;
            if (top  < 8)                           top  = y + 18;
            tip.style.left = left + 'px';
            tip.style.top  = top  + 'px';
        }

        document.addEventListener('mouseover', function(e) {
            const el = e.target.closest('[data-fullname]');
            if (el && el !== current) { current = el; show(el, e.clientX, e.clientY); }
            else if (!el && current) { hide(); }
        });
        document.addEventListener('mousemove', function(e) {
            if (current) move(e.clientX, e.clientY);
        });
        document.addEventListener('mouseout', function(e) {
            if (current && !e.relatedTarget?.closest('[data-fullname]')) hide();
        });
    })();
})();
