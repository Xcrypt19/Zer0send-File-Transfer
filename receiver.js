(function(){
    const socket = io();
    let peerConnection;
    let activeDownloads = new Map();
    let currentReceivingFileId = null;
    let fileCount = 0;

    let _rainInterval = null;
    let _pulseInterval = null;

    // ── Session state ──────────────────────────────────────────
    let expiryTimer     = null;
    let chatOpen        = false;
    let sessionVerified = false;
    let unreadCount     = 0;

    // Completed blobs keyed by fileId for "Download All as ZIP"
    const completedFiles = new Map(); // fileId -> { fileName, relativePath, blob }

    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

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
            html:'fa-file-code', css:'fa-file-code', py:'fa-file-code',
        };
        return iconMap[ext] || 'fa-file';
    }

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
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
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

    function escapeHtml(t) {
        return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Expiry countdown ───────────────────────────────────────
    function startExpiryCountdown(expiryMs) {
        const tick = () => {
            const remaining = expiryMs - Date.now();
            const el = document.getElementById('expiry-countdown');
            if (el) {
                el.textContent = formatCountdown(remaining);
                el.style.color = remaining < 300000 ? '#ff4444' : remaining < 900000 ? '#f59e0b' : '#40c21c';
            }
            if (remaining <= 0) { clearInterval(expiryTimer); burnSession('Session expired — link has self-destructed.'); }
        };
        tick();
        expiryTimer = setInterval(tick, 1000);
    }

    function burnSession(reason) {
        clearInterval(expiryTimer);
        showToast(reason || 'Session terminated.', 'error');
        setTimeout(() => location.reload(), 2500);
    }

    // ── Loading Screen ─────────────────────────────────────────
    function initLoader() {
        const screen   = document.getElementById('loader-screen');
        const canvas   = document.getElementById('loader-rain');
        const fillEl   = document.getElementById('loader-fill');
        const statusEl = document.getElementById('loader-status');
        const dotsEl   = document.getElementById('loader-dots');
        if (!screen || !canvas || !fillEl || !statusEl || !dotsEl) return;
        const dots     = Array.from(dotsEl.children);
        const total    = dots.length;
        const palette  = ['#40c21c','#57d42e','#84f163','#48ecc8','#1eff00','#057a0f'];
        const msgs     = ['connecting to room','locating sender','establishing peer connection','webrtc handshake','securing channel','almost there'];
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
            const idx = Math.floor(t / 28) % msgs.length;
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
        if (!fillEl || !statusEl) { if (onComplete) onComplete(); return; }
        const dots   = Array.from((document.getElementById('loader-dots') || {children:[]}).children);
        const total  = dots.length;
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

    // ── Connect button ─────────────────────────────────────────
    document.querySelector("#receiver-start-con-btn").addEventListener("click", function(){
        const joinID = document.querySelector("#join-id").value.trim();
        if (!joinID.length) { showToast('Please enter a Room ID', 'error'); return; }
        const alias = (document.querySelector("#receiver-alias") || {}).value || '';
        socket.emit("receiver-join", { uid: joinID, alias });
        showToast('Connecting to room…', 'info');
    });

    // ── Socket Events ──────────────────────────────────────────
    socket.on("init", function(senderSocketId){
        showToast('Connected to sender!', 'success');
        document.querySelector(".join-screen").classList.remove("active");
        document.querySelector(".fs-screen").classList.add("active");

        peerConnection = new RTCPeerConnection(configuration);

        peerConnection.ondatachannel = function(event){
            const dataChannel = event.channel;

            dataChannel.onmessage = function(event){
                if (typeof event.data === 'string') {
                    const message = JSON.parse(event.data);
                    if      (message.type === 'metadata')     startFileReceive(message.data);
                    else if (message.type === 'done')         completeFileReceive(message.fileId);
                    else if (message.type === 'remove-file')  removeFileItem(message.fileId);
                    else if (message.type === 'session-meta') handleSessionMeta(message, dataChannel);
                    else if (message.type === 'chat')         appendChatMessage(message.text, 'them', message.alias || 'Sender');
                } else {
                    handleFileChunk(event.data);
                }
            };

            dataChannel.onopen  = function(){ console.log('Data channel open'); };
            dataChannel.onclose = function() { showSenderDisconnected(); };
            window._dataChannel = dataChannel;
        };

        peerConnection.onconnectionstatechange = function() {
            const s = peerConnection.connectionState;
            if (s === 'disconnected' || s === 'failed') showSenderDisconnected();
        };

        peerConnection.onicecandidate = function(event){
            if (event.candidate) socket.emit("candidate", { candidate: event.candidate, uid: senderSocketId });
        };
    });

    // ── Kicked by sender ───────────────────────────────────────
    socket.on("kicked", function(data) {
        // Show a modal overlay rather than immediately reloading
        const overlay = document.createElement('div');
        overlay.id = 'kicked-overlay';
        overlay.innerHTML = `
            <div class="sdo-card">
                <div class="sdo-icon" style="color:#ef4444;"><i class="fas fa-user-slash"></i></div>
                <div class="sdo-title" style="color:#ef4444;">REMOVED FROM SESSION</div>
                <div class="sdo-body">
                    ${escapeHtml(data.reason || 'The sender has removed you from this room.')}
                    <br><br>Any completed files can still be downloaded.
                </div>
                <div class="sdo-actions">
                    <button class="sdo-btn-dismiss" id="kicked-dismiss">
                        <i class="fas fa-download"></i> Stay &amp; Download
                    </button>
                    <button class="sdo-btn-reload">
                        <i class="fas fa-rotate-right"></i> New Session
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.sdo-btn-reload').addEventListener('click', () => location.reload());
        overlay.querySelector('#kicked-dismiss').addEventListener('click', () => {
            overlay.style.transition = 'opacity 0.3s';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 310);
        });

        const si = document.querySelector('.status-indicator');
        if (si) { si.classList.remove('waiting','connected'); si.classList.add('disconnected'); }
        const ct = document.getElementById('connection-text');
        if (ct) ct.textContent = 'Removed by sender';
        showToast('You have been removed from the room.', 'error');
    });

    // ── Session metadata handler ───────────────────────────────
    let _pendingMeta = null;
    let _activeDataChannel = null;

    function handleSessionMeta(meta, dataChannel) {
        _activeDataChannel = dataChannel;
        if (meta.masterKey) {
            _pendingMeta = meta;
            const gate = document.getElementById('passphrase-gate');
            if (gate) gate.classList.add('active');
            setTimeout(() => { const inp = document.getElementById('pg-input'); if (inp) inp.focus(); }, 350);
        } else {
            activateSession(meta, dataChannel);
        }
    }

    window.submitPassphraseGate = function() {
        const inp   = document.getElementById('pg-input');
        const errEl = document.getElementById('pg-error');
        const attEl = document.getElementById('pg-attempts');
        const btn   = document.getElementById('pg-submit-btn');
        if (!inp || !_pendingMeta) return;
        const entered = inp.value.trim();
        if (!entered) { errEl.textContent = 'Please enter the passphrase.'; inp.focus(); return; }
        if (entered === _pendingMeta.masterKey) {
            errEl.textContent = '';
            btn.innerHTML = '<i class="fas fa-check-circle"></i>&nbsp; Verified!';
            btn.classList.add('success');
            inp.disabled = true;
            setTimeout(() => {
                const gate = document.getElementById('passphrase-gate');
                if (gate) gate.classList.remove('active');
                activateSession(_pendingMeta, _activeDataChannel);
                _pendingMeta = null;
            }, 900);
        } else {
            inp.classList.add('shake');
            inp.value = '';
            setTimeout(() => inp.classList.remove('shake'), 450);
            errEl.textContent = 'Incorrect passphrase — try again.';
            inp.focus();
            if (!window._pgAttempts) window._pgAttempts = 0;
            window._pgAttempts++;
            if (window._pgAttempts >= 3) attEl.textContent = `${window._pgAttempts} failed attempt${window._pgAttempts > 1 ? 's' : ''}`;
            if (window._pgAttempts >= 5) {
                errEl.textContent = 'Too many failed attempts — session closed.';
                inp.disabled = true; btn.disabled = true;
                if (_activeDataChannel) _activeDataChannel.send(JSON.stringify({ type: 'key-rejected' }));
                setTimeout(() => location.reload(), 2500);
            }
        }
    };

    document.addEventListener('DOMContentLoaded', function() {
        const inp = document.getElementById('pg-input');
        if (inp) inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') window.submitPassphraseGate(); });
    });

    function activateSession(meta, dataChannel) {
        sessionVerified = true;
        const expiryBand = document.getElementById('expiry-band');
        if (expiryBand) {
            expiryBand.style.display = 'flex';
            const lbl = document.getElementById('expiry-label');
            if (lbl) lbl.textContent = 'Session self-destructs in:';
        }
        if (meta.expiryMs) startExpiryCountdown(meta.expiryMs);
        const passphraseNote = meta.masterKey ? ' · Passphrase verified ✓' : '';
        showToast(`Session secured. Expires in ${meta.expiryLabel || '...'}${passphraseNote}`, 'success');
    }

    // ── File receiving ─────────────────────────────────────────
    function startFileReceive(metadata) {
        const waitingSection = document.getElementById('waiting-section');
        if (waitingSection) waitingSection.style.display = 'none';

        const dl = {
            fileId:        metadata.fileId,
            fileName:      metadata.fileName,
            fileSize:      metadata.fileSize,
            fileType:      metadata.fileType || 'application/octet-stream',
            relativePath:  metadata.relativePath || '',
            chunks:        [],
            receivedBytes: 0,
            startTime:     Date.now(),
            completed:     false
        };
        activeDownloads.set(metadata.fileId, dl);
        currentReceivingFileId = metadata.fileId;

        const displayName = dl.relativePath || dl.fileName;

        const row = document.createElement('div');
        row.classList.add('item');
        row.id = 'file-' + metadata.fileId;
        row.style.setProperty('--pct', '0%');
        row.innerHTML = `
            <div class="file-card-body">
                <i class="fas ${getFileIcon(metadata.fileName)} file-card-icon"></i>
                <div class="file-card-meta">
                    <div class="file-card-name" title="${escapeHtml(displayName)}" data-fullname="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                    <div class="file-card-size">${formatFileSize(metadata.fileSize)}</div>
                </div>
                <div class="file-card-pct">0%</div>
            </div>
        `;
        document.querySelector('.files-list').appendChild(row);
        fileCount++;
        updateFileCount();
        showToast(`Receiving ${displayName}…`, 'info');
    }

    function handleFileChunk(chunk) {
        const dl = currentReceivingFileId ? activeDownloads.get(currentReceivingFileId) : null;
        if (!dl || dl.completed) return;
        dl.chunks.push(chunk);
        dl.receivedBytes += chunk.byteLength;
        const row = document.getElementById('file-' + dl.fileId);
        if (row) {
            const pct = dl.fileSize > 0 ? Math.min(Math.round((dl.receivedBytes / dl.fileSize) * 100), 100) : 0;
            row.style.setProperty('--pct', pct + '%');
            const pctEl = row.querySelector('.file-card-pct');
            if (pctEl) pctEl.textContent = pct + '%';
        }
        if (dl.chunks.length > 500) {
            dl.chunks = [new Blob(dl.chunks, { type: dl.fileType })];
        }
    }

    function completeFileReceive(fileId) {
        const dl = activeDownloads.get(fileId);
        if (!dl) return;
        dl.completed = true;
        if (currentReceivingFileId === fileId) currentReceivingFileId = null;

        const dur = Math.max((Date.now() - dl.startTime) / 1000, 0.001);
        const spd = (dl.fileSize / dur / 1024 / 1024).toFixed(2);

        const row = document.getElementById('file-' + fileId);
        const finalBlob = new Blob(dl.chunks, { type: dl.fileType });

        // Store for "Download All as ZIP"
        completedFiles.set(fileId, {
            fileName:     dl.fileName,
            relativePath: dl.relativePath,
            blob:         finalBlob
        });
        updateDownloadAllBtn();

        if (row) {
            row.style.setProperty('--pct', '100%');
            row.classList.add('download-ready');
            const pctEl = row.querySelector('.file-card-pct');
            if (pctEl) { pctEl.innerHTML = '<i class="fas fa-arrow-down"></i>'; }
            row.title = 'Click to download';
            row.addEventListener('click', function() {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(finalBlob);
                a.download = dl.fileName;
                a.click();
                URL.revokeObjectURL(a.href);
            });
        }
        showToast(`${dl.relativePath || dl.fileName} ready — ${spd} MB/s (${formatTime(dur)})`, 'success');
        activeDownloads.delete(fileId);
    }

    function removeFileItem(fileId) {
        const row = document.getElementById('file-' + fileId);
        if (row) {
            row.style.transition = 'opacity 0.25s, transform 0.25s';
            row.style.opacity    = '0';
            row.style.transform  = 'translateX(16px)';
            setTimeout(() => { row.remove(); fileCount--; updateFileCount(); }, 260);
        }
        completedFiles.delete(fileId);
        updateDownloadAllBtn();
        showToast('A file was removed by the sender.', 'info');
    }

    // ── Download All as ZIP ────────────────────────────────────
    function updateDownloadAllBtn() {
        const btn = document.getElementById('download-all-btn');
        if (!btn) return;
        btn.style.display = completedFiles.size >= 2 ? 'inline-flex' : 'none';
        btn.querySelector('.dab-count').textContent = completedFiles.size + ' files';
    }

    window.downloadAllAsZip = async function() {
        if (completedFiles.size === 0) return;
        const btn = document.getElementById('download-all-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Building ZIP…'; }

        // Load JSZip from CDN
        if (!window.JSZip) {
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                s.onload = res; s.onerror = rej;
                document.head.appendChild(s);
            });
        }

        const zip = new window.JSZip();
        completedFiles.forEach(({ fileName, relativePath, blob }) => {
            const zipPath = relativePath || fileName;
            zip.file(zipPath, blob);
        });

        try {
            const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = 'zer0send-files.zip';
            a.click();
            URL.revokeObjectURL(a.href);
            showToast(`Downloaded ${completedFiles.size} files as ZIP!`, 'success');
        } catch (err) {
            showToast('ZIP error: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fas fa-file-archive"></i> Download All as ZIP <span class="dab-count">${completedFiles.size} files</span>`;
            }
        }
    };

    // ── WebRTC answer / ICE candidate ──────────────────────────
    socket.on("offer", function(data){
        peerConnection.setRemoteDescription(data.offer)
            .then(() => peerConnection.createAnswer())
            .then(answer => peerConnection.setLocalDescription(answer))
            .then(() => socket.emit("answer", { answer: peerConnection.localDescription, uid: data.uid }));
    });

    socket.on("candidate", data => peerConnection.addIceCandidate(data.candidate));
    socket.on("error",     data => showToast(data.message || 'Connection error', 'error'));

    // ── Room ID input formatter ────────────────────────────────
    const joinIdInput = document.getElementById('join-id');
    if (joinIdInput) {
        joinIdInput.addEventListener('input', function(e) {
            let value = e.target.value.replace(/[^0-9-]/g, '');
            if (value.length > 3 && value[3] !== '-') value = value.slice(0,3) + '-' + value.slice(3);
            if (value.length > 7 && value[7] !== '-') value = value.slice(0,7) + '-' + value.slice(7);
            e.target.value = value.slice(0, 11);
        });
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
        const dc = window._dataChannel;
        if (!dc || dc.readyState !== 'open') { showToast('Not connected — cannot send message.', 'error'); return; }
        dc.send(JSON.stringify({ type:'chat', text, alias:'Receiver' }));
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
        if (unreadCount > 0) { badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount); badge.classList.add('visible'); }
        else { badge.textContent = ''; badge.classList.remove('visible'); }
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

    // ── Sender-disconnected overlay ────────────────────────────
    let _disconnectShown = false;
    function showSenderDisconnected() {
        if (_disconnectShown) return;
        _disconnectShown = true;
        const connText = document.getElementById('connection-text');
        if (connText) connText.textContent = 'Sender disconnected';
        const si = document.querySelector('.status-indicator');
        if (si) { si.classList.remove('waiting', 'connected'); si.classList.add('disconnected'); }
        const now     = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const overlay = document.createElement('div');
        overlay.id = 'sender-disconnected-overlay';
        overlay.innerHTML = `
            <div class="sdo-card">
                <div class="sdo-icon"><i class="fas fa-plug-circle-xmark"></i></div>
                <div class="sdo-title">SENDER DISCONNECTED</div>
                <div class="sdo-body">
                    The sender has left the session.<br>
                    Any completed files can still be downloaded.
                </div>
                <div class="sdo-time"><i class="fas fa-clock"></i> Disconnected at ${timeStr}</div>
                <div class="sdo-actions">
                    <button class="sdo-btn-dismiss" id="sdo-dismiss">
                        <i class="fas fa-check"></i> Stay &amp; Download
                    </button>
                    <button class="sdo-btn-reload">
                        <i class="fas fa-rotate-right"></i> New Session
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.sdo-btn-reload').addEventListener('click', () => location.reload());
        overlay.querySelector('#sdo-dismiss').addEventListener('click', () => {
            overlay.style.transition = 'opacity 0.3s ease';
            overlay.style.opacity    = '0';
            setTimeout(() => overlay.remove(), 310);
        });
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
        function hide() { tip.classList.remove('visible'); current = null; }
        function move(x, y) {
            const tw = tip.offsetWidth;
            let left = x + OFFSET_X;
            let top  = y + OFFSET_Y;
            if (left + tw > window.innerWidth - 8) left = x - tw - OFFSET_X;
            if (top < 8) top = y + 18;
            tip.style.left = left + 'px';
            tip.style.top  = top  + 'px';
        }
        document.addEventListener('mouseover', function(e) {
            const el = e.target.closest('[data-fullname]');
            if (el && el !== current) { current = el; show(el, e.clientX, e.clientY); }
            else if (!el && current) { hide(); }
        });
        document.addEventListener('mousemove', function(e) { if (current) move(e.clientX, e.clientY); });
        document.addEventListener('mouseout', function(e) {
            if (current && !e.relatedTarget?.closest('[data-fullname]')) hide();
        });
    })();
})();
