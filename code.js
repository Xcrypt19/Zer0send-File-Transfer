(function(){
    // ── Peer registry: socketId → { peerConnection, dataChannel } ─
    const peers = new Map();
    let connectedCount = 0;
    let screenSwitched = false;

    const socket = io();
    let fileCount = 0;
    let activeTransfers = new Map();

    let _rainInterval = null;
    let _pulseInterval = null;

    // ── Session state ──────────────────────────────────────────
    let passphrase     = '';
    let expiryMs       = 0;
    let expiryTimer    = null;
    let sessionActive  = false;
    let chatOpen       = false;
    let unreadCount    = 0;
    let currentRoomUID = '';

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302'  },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
        ],
        iceCandidatePoolSize: 10,   // pre-gather candidates before offer — cuts 200-400ms off connect time
        bundlePolicy:  'max-bundle',
        rtcpMuxPolicy: 'require',
    };

    function generateID(){
        const seg = () => Math.floor(Math.random() * 900) + 100;
        return `${seg()}-${seg()}-${seg()}`;
    }

    // ── Toast ──────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fas fa-${type==='success'?'check-circle':type==='error'?'exclamation-circle':'info-circle'}"></i><span>${message}</span>`;
        document.getElementById('toast-container').appendChild(toast);
        setTimeout(() => { toast.style.animation = 'slideInRight 0.3s ease reverse'; setTimeout(() => toast.remove(), 300); }, 3000);
    }

    // ── Helpers ────────────────────────────────────────────────
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024, sizes = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
    }
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return '…';
        if (seconds < 60)   return Math.round(seconds) + 's';
        if (seconds < 3600) return Math.floor(seconds/60) + 'm ' + Math.round(seconds%60) + 's';
        return Math.floor(seconds/3600) + 'h ' + Math.floor((seconds%3600)/60) + 'm';
    }
    function formatCountdown(ms) {
        if (ms <= 0) return '00:00:00';
        const t = Math.ceil(ms/1000);
        return [Math.floor(t/3600), Math.floor((t%3600)/60), t%60].map(v => String(v).padStart(2,'0')).join(':');
    }
    function updateFileCount() {
        const el = document.getElementById('file-count');
        if (el) el.textContent = `${fileCount} file${fileCount!==1?'s':''}`;
    }
    function getFileIcon(fileName) {
        const ext = (fileName.split('.').pop()||'').toLowerCase();
        const m = { pdf:'fa-file-pdf',doc:'fa-file-word',docx:'fa-file-word',xls:'fa-file-excel',xlsx:'fa-file-excel',
            ppt:'fa-file-powerpoint',pptx:'fa-file-powerpoint',jpg:'fa-file-image',jpeg:'fa-file-image',
            png:'fa-file-image',gif:'fa-file-image',webp:'fa-file-image',svg:'fa-file-image',
            zip:'fa-file-archive',rar:'fa-file-archive','7z':'fa-file-archive',tar:'fa-file-archive',gz:'fa-file-archive',
            mp3:'fa-file-audio',wav:'fa-file-audio',flac:'fa-file-audio',aac:'fa-file-audio',ogg:'fa-file-audio',
            mp4:'fa-file-video',avi:'fa-file-video',mkv:'fa-file-video',mov:'fa-file-video',webm:'fa-file-video',
            txt:'fa-file-alt',md:'fa-file-alt',json:'fa-file-code',js:'fa-file-code',ts:'fa-file-code',
            html:'fa-file-code',css:'fa-file-code',py:'fa-file-code',java:'fa-file-code' };
        return m[ext] || 'fa-file';
    }
    function escapeHtml(t) {
        return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Binary chunk packing ───────────────────────────────────
    // Each binary DataChannel message: [24-byte ASCII fileId header][chunk data]
    // This lets the receiver route chunks to the correct download by ID,
    // fixing the multi-file interleaving bug without any JSON overhead.
    const HEADER_LEN = 24;
    function packChunk(fileId, buffer) {
        const out = new Uint8Array(HEADER_LEN + buffer.byteLength);
        for (let i = 0; i < Math.min(fileId.length, HEADER_LEN); i++) out[i] = fileId.charCodeAt(i);
        out.set(new Uint8Array(buffer), HEADER_LEN);
        return out.buffer;
    }

    // ── Broadcast helpers ──────────────────────────────────────
    function broadcastData(data) {
        peers.forEach(({ dataChannel }) => {
            if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(data);
        });
    }
    function anyChannelBackedUp() {
        for (const { dataChannel } of peers.values()) {
            if (dataChannel && dataChannel.readyState === 'open' && dataChannel.bufferedAmount > 8388608) return true; // 8 MB
        }
        return false;
    }

    // ── Connection UI ──────────────────────────────────────────
    function updateConnectionUI() {
        const txt   = document.getElementById('connection-text');
        const si    = document.querySelector('.status-indicator');
        const badge = document.getElementById('user-count-badge');
        if (connectedCount > 0) {
            if (txt) txt.textContent = `${connectedCount} receiver${connectedCount!==1?'s':''} connected`;
            if (si) { si.classList.remove('waiting','disconnected'); si.classList.add('connected'); }
        } else {
            if (txt) txt.textContent = 'Waiting for receiver…';
            if (si) { si.classList.remove('connected','disconnected'); si.classList.add('waiting'); }
        }
        if (badge) badge.textContent = connectedCount + ' online';
    }

    // ── Connected Users Panel ──────────────────────────────────
    function renderUserRow(socketId, alias) {
        const list = document.getElementById('users-list');
        if (!list || document.getElementById('user-row-' + socketId)) return;
        const msg = document.getElementById('no-users-msg');
        if (msg) msg.style.display = 'none';
        const row = document.createElement('div');
        row.className = 'user-row';
        row.id = 'user-row-' + socketId;
        row.innerHTML = `
            <div class="user-row-info">
                <span class="user-dot"></span>
                <span class="user-alias">${escapeHtml(alias)}</span>
            </div>
            <button class="kick-btn" onclick="kickReceiver('${escapeHtml(socketId)}')">
                <i class="fas fa-user-slash"></i> Kick
            </button>`;
        list.appendChild(row);
    }
    function removeUserRow(socketId) {
        const row = document.getElementById('user-row-' + socketId);
        if (!row) return;
        row.style.opacity = '0'; row.style.transition = 'opacity 0.3s';
        setTimeout(() => {
            row.remove();
            const list = document.getElementById('users-list');
            if (list && !list.querySelector('.user-row')) {
                const msg = document.getElementById('no-users-msg');
                if (msg) msg.style.display = '';
            }
        }, 310);
    }
    window.kickReceiver = function(socketId) {
        socket.emit('kick-receiver', { receiverSocketId: socketId, uid: currentRoomUID });
        const peer = peers.get(socketId);
        if (peer) {
            try { peer.dataChannel && peer.dataChannel.close(); } catch(e){}
            try { peer.peerConnection.close(); } catch(e){}
            peers.delete(socketId);
        }
        connectedCount = Math.max(0, connectedCount - 1);
        updateConnectionUI();
        removeUserRow(socketId);
        showToast('User removed from room.', 'info');
    };

    // ── Expiry ─────────────────────────────────────────────────
    function startExpiryCountdown() {
        const tick = () => {
            const rem = expiryMs - Date.now();
            const el  = document.getElementById('expiry-countdown');
            if (el) { el.textContent = formatCountdown(rem); el.style.color = rem < 300000 ? '#ff4444' : rem < 900000 ? '#f59e0b' : '#40c21c'; }
            if (rem <= 0) { clearInterval(expiryTimer); burnSession('Session expired — link self-destructed.'); }
        };
        tick(); expiryTimer = setInterval(tick, 1000);
    }
    function burnSession(reason) {
        clearInterval(expiryTimer); sessionActive = false;
        showToast(reason || 'Session terminated.', 'error');
        setTimeout(() => location.reload(), 2500);
    }

    // ── Loading Screen ─────────────────────────────────────────
    function initLoader(roomID) {
        const screen = document.getElementById('loader-screen'), canvas = document.getElementById('loader-rain');
        const fillEl = document.getElementById('loader-fill'), statusEl = document.getElementById('loader-status');
        const dotsEl = document.getElementById('loader-dots'), roomEl = document.getElementById('loader-room-id');
        if (roomEl) roomEl.textContent = roomID;
        if (!screen || !canvas || !fillEl || !statusEl || !dotsEl) return;
        const dots = Array.from(dotsEl.children), total = dots.length;
        const palette = ['#40c21c','#57d42e','#84f163','#48ecc8','#1eff00','#057a0f'];
        const msgs = ['room created','broadcasting room id','awaiting peer','listening for receiver','standing by','waiting for receiver'];
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const ctx = canvas.getContext('2d');
            canvas.width = screen.offsetWidth || 800; canvas.height = screen.offsetHeight || 600;
            const cols = Math.floor(canvas.width/18), drops = Array.from({length:cols}, () => Math.random()*-60);
            _rainInterval = setInterval(() => {
                ctx.fillStyle = 'rgba(6,26,8,0.15)'; ctx.fillRect(0,0,canvas.width,canvas.height);
                for (let i = 0; i < drops.length; i++) {
                    const bit = Math.random()>0.5?'1':'0', bright = drops[i]*18 > canvas.height*0.55;
                    ctx.fillStyle = bright ? palette[Math.floor(Math.random()*2)] : palette[2+Math.floor(Math.random()*4)];
                    ctx.font = (Math.random()>0.8?13:10)+"px 'Share Tech Mono',monospace";
                    ctx.globalAlpha = bright ? 0.15+Math.random()*0.2 : 0.05+Math.random()*0.12;
                    ctx.fillText(bit, i*18, drops[i]*18); ctx.globalAlpha = 1;
                    if (drops[i]*18 > canvas.height && Math.random()>0.96) drops[i] = 0;
                    drops[i] += 0.3+Math.random()*0.35;
                }
            }, 60);
        }));
        let t = 0, progress = 0, lastMsg = '';
        _pulseInterval = setInterval(() => {
            t++;
            const target = 55 + Math.sin(t*0.05)*7;
            progress = progress < target ? Math.min(progress+0.5,target) : Math.max(progress-0.15,target);
            fillEl.style.width = progress + '%';
            const lit = Math.floor((progress/100)*total);
            dots.forEach((d,i) => { d.className = 'ldot'+(i<lit?' lit':'')+(i===lit?' active':''); });
            const idx = Math.floor(t/30) % msgs.length;
            if (msgs[idx] !== lastMsg) {
                statusEl.style.opacity = '0';
                setTimeout(() => { statusEl.textContent = msgs[idx]; statusEl.style.opacity = '1'; lastMsg = msgs[idx]; }, 300);
            }
        }, 100);
    }
    function finishLoader(onComplete) {
        clearInterval(_rainInterval); clearInterval(_pulseInterval);
        const fillEl = document.getElementById('loader-fill'), statusEl = document.getElementById('loader-status');
        if (!fillEl || !statusEl) { if (onComplete) onComplete(); return; }
        const dots = Array.from((document.getElementById('loader-dots')||{children:[]}).children), total = dots.length;
        statusEl.style.opacity = '0';
        setTimeout(() => { statusEl.textContent = 'connected'; statusEl.style.opacity = '1'; }, 300);
        let p = parseFloat(fillEl.style.width)||0;
        const sweep = setInterval(() => {
            p = Math.min(p+3,100); fillEl.style.width = p+'%';
            const lit = Math.floor((p/100)*total);
            dots.forEach((d,i) => { d.className = 'ldot'+(i<lit?' lit':'')+(i===lit?' active':''); });
            if (p >= 100) { clearInterval(sweep); setTimeout(onComplete, 500); }
        }, 18);
    }

    // ── Passphrase Accordion ───────────────────────────────────
    window.togglePassphrase = function() {
        const btn = document.getElementById('mk-toggle-btn'), body = document.getElementById('mk-body');
        if (!btn || !body) return;
        const isOpen = body.classList.contains('open');
        body.classList.toggle('open', !isOpen); btn.classList.toggle('open', !isOpen);
        if (!isOpen) setTimeout(() => { const inp = document.getElementById('mk-input-field'); if (inp) inp.focus(); }, 320);
    };
    window.applyPassphrase = function() {
        const inp = document.getElementById('mk-input-field'), btn = document.getElementById('mk-apply-btn');
        const status = document.getElementById('mk-status-text'), accord = document.getElementById('master-key-panel');
        const toggle = document.getElementById('mk-toggle-btn');
        if (!inp) return;
        const val = inp.value.trim();
        if (!val) { if (status) { status.textContent = '⚠ Enter a passphrase first.'; status.className = 'mk-set-status err'; } inp.focus(); return; }
        passphrase = val;
        if (btn) { btn.innerHTML = '<i class="fas fa-check-circle"></i> Applied!'; btn.classList.add('success'); setTimeout(() => { btn.innerHTML = '<i class="fas fa-check"></i> Apply'; btn.classList.remove('success'); }, 2200); }
        if (status) { status.textContent = '✓ Passphrase set — receiver will be prompted on connect.'; status.className = 'mk-set-status ok'; }
        if (accord) accord.classList.add('applied'); if (toggle) toggle.classList.add('applied');
        setTimeout(() => { const body = document.getElementById('mk-body'); if (body) body.classList.remove('open'); if (toggle) toggle.classList.remove('open'); }, 1800);
    };
    window.clearPassphrase = function() {
        passphrase = '';
        const inp = document.getElementById('mk-input-field'), status = document.getElementById('mk-status-text');
        const accord = document.getElementById('master-key-panel'), toggle = document.getElementById('mk-toggle-btn');
        if (inp) inp.value = '';
        if (status) { status.textContent = 'Passphrase cleared.'; status.className = 'mk-set-status'; }
        if (accord) accord.classList.remove('applied'); if (toggle) toggle.classList.remove('applied');
        setTimeout(() => { if (status) status.textContent = ''; }, 2000);
    };
    document.addEventListener('DOMContentLoaded', () => {
        const inp = document.getElementById('mk-input-field');
        if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') window.applyPassphrase(); });
    });

    // ── Create Room ────────────────────────────────────────────
    document.querySelector("#sender-start-con-btn").addEventListener("click", function(){
        const joinID = generateID();
        currentRoomUID = joinID;
        const expiryChoice = document.querySelector('input[name="expiry"]:checked');
        const expiryHours  = expiryChoice ? parseInt(expiryChoice.value) : 24;
        expiryMs = Date.now() + expiryHours * 3600000;
        const expiryLabel = expiryHours === 1 ? '1 hour' : expiryHours === 24 ? '24 hours' : '7 days';
        document.querySelector("#join-id").innerHTML = `
            <b><i class="fas fa-key"></i> Room ID</b>
            <span onclick="copyToClipboard(this.textContent)">${joinID}</span>
            <p style="color:var(--text-secondary);font-size:0.75rem;margin-top:0.5rem;"><i class="fas fa-copy"></i> Click to copy</p>`;
        const expBadge = document.getElementById('expiry-badge');
        if (expBadge) { expBadge.style.display = 'flex'; document.getElementById('expiry-label').textContent = `Self-destructs in ${expiryLabel}`; }
        socket.emit("sender-join", { uid: joinID, masterKey: passphrase, expiryMs });
        showToast(`Room created! Expires in ${expiryLabel}.${passphrase?' Passphrase auth enabled.':''}`, 'success');
        const si = document.querySelector('.status-indicator');
        if (si) { si.classList.remove('connected','disconnected'); si.classList.add('waiting'); }
    });
    window.copyToClipboard = text => navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));

    // ── Socket Events ──────────────────────────────────────────
    socket.on("init", function(receiverSocketId){
        sessionActive = true;
        const pc = new RTCPeerConnection(configuration);

        // Ordered + reliable data channel — required for correct chunk ordering
        const dc = pc.createDataChannel("fileTransfer", {
            ordered: true
        });
        dc.bufferedAmountLowThreshold = 2097152; // 2 MB — resume when buffer drains below this

        peers.set(receiverSocketId, { peerConnection: pc, dataChannel: dc });

        dc.onopen = function(){
            connectedCount++;
            updateConnectionUI();
            showToast('New receiver connected!', 'success');
            dc.send(JSON.stringify({ type:'session-meta', masterKey:passphrase, expiryMs, expiryLabel:getExpiryLabel() }));
            if (connectedCount === 1) startExpiryCountdown();
        };
        dc.onmessage = function(event) {
            if (typeof event.data === 'string') {
                const msg = JSON.parse(event.data);
                if (msg.type === 'chat') appendChatMessage(msg.text, 'them', msg.alias || 'Receiver');
            }
        };
        dc.onbufferedamountlow = function(){
            if (!anyChannelBackedUp()) {
                activeTransfers.forEach(t => { if (t.paused && t.resume) { t.paused = false; t.resume(); } });
            }
        };
        dc.onclose = function(){
            if (!peers.has(receiverSocketId)) return;
            peers.delete(receiverSocketId);
            connectedCount = Math.max(0, connectedCount - 1);
            updateConnectionUI();
            removeUserRow(receiverSocketId);
            showToast('A receiver disconnected.', 'error');
        };
        pc.onicecandidate = e => { if (e.candidate) socket.emit("candidate", { candidate: e.candidate, uid: receiverSocketId }); };
        pc.createOffer()
            .then(o => pc.setLocalDescription(o))
            .then(() => socket.emit("offer", { offer: pc.localDescription, uid: receiverSocketId }));
        if (!screenSwitched) {
            screenSwitched = true;
            document.querySelector(".join-screen").classList.remove("active");
            document.querySelector(".fs-screen").classList.add("active");
        }
    });

    function getExpiryLabel() {
        const r = expiryMs - Date.now();
        return r > 20*3600000 ? '7 days' : r > 2*3600000 ? '24 hours' : '1 hour';
    }
    socket.on("answer",    d => { const p = peers.get(d.uid); if (p) p.peerConnection.setRemoteDescription(d.answer); });
    socket.on("candidate", d => { const p = peers.get(d.uid); if (p) p.peerConnection.addIceCandidate(d.candidate); });
    socket.on("receiver-list", function(data) {
        const badge = document.getElementById('user-count-badge');
        if (badge) badge.textContent = data.count + ' online';
        const existing = new Set(Array.from(document.querySelectorAll('.user-row')).map(el => el.id.replace('user-row-','')));
        const fresh = new Set(data.receivers.map(r => r.socketId));
        existing.forEach(sid => { if (!fresh.has(sid)) removeUserRow(sid); });
        data.receivers.forEach(r => { if (!existing.has(r.socketId)) renderUserRow(r.socketId, r.alias); });
    });
    socket.on("receiver-left", d => removeUserRow(d.socketId));

    // ── Drag & Drop ────────────────────────────────────────────
    const dropArea    = document.getElementById('drop-area');
    const fileInput   = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');

    ['dragenter','dragover','dragleave','drop'].forEach(ev => dropArea.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, false));
    ['dragenter','dragover'].forEach(ev => dropArea.addEventListener(ev, () => dropArea.classList.add('dragover'), false));
    ['dragleave','drop'].forEach(ev => dropArea.addEventListener(ev, () => dropArea.classList.remove('dragover'), false));

    function hasOpenChannel() {
        for (const { dataChannel } of peers.values()) if (dataChannel && dataChannel.readyState === 'open') return true;
        return false;
    }

    dropArea.addEventListener('drop', async function(e) {
        if (!hasOpenChannel()) { showToast('No receivers connected yet.', 'error'); return; }
        const items = Array.from(e.dataTransfer.items || []);
        if (items.some(i => i.webkitGetAsEntry?.()?.isDirectory)) {
            for (const item of items) { const entry = item.webkitGetAsEntry?.(); if (entry) await traverseEntry(entry, ''); }
        } else {
            Array.from(e.dataTransfer.files).forEach(f => sendFile(f, f.name));
        }
    }, false);

    async function traverseEntry(entry, basePath) {
        if (entry.isFile) {
            return new Promise(res => entry.file(f => { sendFile(f, basePath ? basePath+'/'+entry.name : entry.name); res(); }, res));
        } else if (entry.isDirectory) {
            const dirPath = basePath ? basePath+'/'+entry.name : entry.name;
            const reader  = entry.createReader();
            await new Promise(res => {
                function readBatch() {
                    reader.readEntries(async function(entries) {
                        if (!entries.length) { res(); return; }
                        for (const e of entries) await traverseEntry(e, dirPath);
                        readBatch();
                    }, res);
                }
                readBatch();
            });
        }
    }

    fileInput.addEventListener("change", function(e) {
        if (!hasOpenChannel()) { showToast('No receivers connected yet.', 'error'); fileInput.value = ''; return; }
        Array.from(e.target.files).forEach(f => sendFile(f, f.name));
        fileInput.value = '';
    });
    if (folderInput) {
        folderInput.addEventListener("change", function(e) {
            if (!hasOpenChannel()) { showToast('No receivers connected yet.', 'error'); folderInput.value = ''; return; }
            Array.from(e.target.files).forEach(f => sendFile(f, f.webkitRelativePath || f.name));
            folderInput.value = '';
        });
    }

    // ── Send File — high-throughput pipelined engine ───────────
    //
    // Optimisations vs the naïve approach:
    //   • CHUNK = 256 KB → 4× fewer dc.send() calls, SCTP frames, and receiver onmessage events vs 64 KB
    //   • QUEUE_DEPTH = 24 → up to 6 MB of reads in flight so disk I/O never stalls the pipeline
    //   • Blob.arrayBuffer() → microtask scheduling; no FileReader object allocation per chunk
    //   • packChunk() → 24-byte binary header carries fileId so multi-file drops work correctly
    //   • rAF-throttled UI → DOM writes batched to ≤60/s instead of one per chunk
    //   • Back-pressure at 8 MB → drain loop runs longer between pauses = higher sustained throughput
    //
    function sendFile(file, relativePath) {
        const fileId      = Date.now() + '-' + Math.floor(Math.random() * 1e9);
        const CHUNK       = 262144;  // 256 KB — sweet-spot for SCTP throughput on all modern browsers
        const QUEUE_DEPTH = 24;      // chunks pre-read in parallel; 24 × 256 KB = 6 MB look-ahead

        let readAhead    = 0;
        let sentBytes    = 0;
        const queue      = [];
        let activeReads  = 0;
        let draining     = false;
        let isCancelled  = false;
        const startTime  = Date.now();

        const displayName = relativePath || file.name;

        // Send metadata first — receiver creates the file entry on receipt
        broadcastData(JSON.stringify({
            type: 'metadata',
            data: { fileId, fileName: file.name, fileSize: file.size, fileType: file.type || 'application/octet-stream', relativePath: relativePath || '' }
        }));

        // ── UI row ─────────────────────────────────────────────
        const row = document.createElement('div');
        row.classList.add('item'); row.dataset.fileId = fileId; row.style.setProperty('--pct', '0%');
        row.innerHTML = `
            <button class="remove-file-btn" title="Remove file"><i class="fas fa-times"></i></button>
            <div class="file-card-body">
                <i class="fas ${getFileIcon(file.name)} file-card-icon"></i>
                <div class="file-card-meta">
                    <div class="file-card-name" title="${escapeHtml(displayName)}" data-fullname="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                    <div class="file-card-size">${formatFileSize(file.size)}</div>
                </div>
                <div class="file-card-pct">0%</div>
            </div>`;
        document.querySelector('.files-list').appendChild(row);
        fileCount++; updateFileCount();

        row.querySelector('.remove-file-btn').addEventListener('click', function() {
            isCancelled = true; activeTransfers.delete(fileId);
            broadcastData(JSON.stringify({ type: 'remove-file', fileId }));
            row.style.transition = 'opacity 0.25s,transform 0.25s';
            row.style.opacity = '0'; row.style.transform = 'translateX(16px)';
            setTimeout(() => { row.remove(); fileCount--; updateFileCount(); }, 260);
            showToast(`${file.name} removed.`, 'info');
        });

        // ── rAF-throttled UI refresh ───────────────────────────
        // Batches DOM writes to ≤60 fps regardless of how fast chunks are sent.
        let rafPending = false;
        function scheduleRefreshUI() {
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                const pct = file.size > 0 ? Math.min(Math.round((sentBytes / file.size) * 100), 100) : 0;
                row.style.setProperty('--pct', pct + '%');
                const el = row.querySelector('.file-card-pct');
                if (el) el.textContent = pct + '%';
            });
        }

        // ── Pre-read chunks with Blob.arrayBuffer() ────────────
        // arrayBuffer() resolves on the microtask queue — faster than FileReader's macrotask events.
        function fillQueue() {
            while (!isCancelled && activeReads + queue.length < QUEUE_DEPTH && readAhead < file.size) {
                const start = readAhead;
                const end   = Math.min(readAhead + CHUNK, file.size);
                readAhead   = end;
                activeReads++;
                file.slice(start, end).arrayBuffer()
                    .then(buf => {
                        if (isCancelled) { activeReads--; return; }
                        activeReads--;
                        queue.push(buf);
                        fillQueue();           // keep read pipeline full
                        if (!draining) drain();
                    })
                    .catch(() => showToast(`Read error on "${file.name}"`, 'error'));
            }
        }

        // ── Drain queue into DataChannel ───────────────────────
        function drain() {
            if (isCancelled) return;
            draining = true;

            while (queue.length > 0) {
                if (anyChannelBackedUp()) {
                    // Pause until bufferedamountlow fires on each channel
                    activeTransfers.set(fileId, {
                        paused: true,
                        resume: () => { activeTransfers.delete(fileId); drain(); }
                    });
                    draining = false;
                    return;
                }
                const buf = queue.shift();
                broadcastData(packChunk(fileId, buf));   // binary header + data
                sentBytes += buf.byteLength;
                scheduleRefreshUI();                     // throttled — won't block the loop
            }

            if (sentBytes >= file.size && activeReads === 0 && queue.length === 0) {
                const dur = Math.max((Date.now() - startTime) / 1000, 0.001);
                const spd = (file.size / dur / 1048576).toFixed(2);
                broadcastData(JSON.stringify({ type: 'done', fileId }));
                row.style.setProperty('--pct', '100%');
                row.classList.add('send-complete');
                const el = row.querySelector('.file-card-pct');
                if (el) el.textContent = '✓';
                showToast(`${file.name} sent — ${spd} MB/s (${formatTime(dur)})`, 'success');
                activeTransfers.delete(fileId);
                draining = false;
                return;
            }

            draining = false;
        }

        fillQueue();
    }

    // ── Secure Messaging ───────────────────────────────────────
    window.toggleChat = function() {
        chatOpen = !chatOpen;
        const panel = document.getElementById('chat-panel'), btn = document.getElementById('chat-toggle-btn');
        if (panel) panel.classList.toggle('open', chatOpen);
        if (btn) btn.classList.toggle('active', chatOpen);
        if (chatOpen) { unreadCount = 0; updateChatBadge(); const input = document.getElementById('chat-input'); if (input) input.focus(); scrollChatToBottom(); }
    };
    window.sendChatMessage = function() {
        const input = document.getElementById('chat-input');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        if (!hasOpenChannel()) { showToast('Not connected — cannot send message.', 'error'); return; }
        broadcastData(JSON.stringify({ type:'chat', text, alias:'Sender' }));
        appendChatMessage(text, 'me', 'You'); input.value = '';
    };
    document.addEventListener('keydown', e => { if (e.key === 'Enter' && document.activeElement?.id === 'chat-input') window.sendChatMessage(); });

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
        div.innerHTML = `<div class="chat-alias">${escapeHtml(alias)}</div><div class="chat-bubble">${escapeHtml(text)}</div><div class="chat-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>`;
        log.appendChild(div); scrollChatToBottom();
        if (side === 'them' && !chatOpen) {
            unreadCount++; updateChatBadge();
            const btn = document.getElementById('chat-toggle-btn');
            if (btn) { btn.classList.add('pulse'); setTimeout(() => btn.classList.remove('pulse'), 2000); }
        }
    }
    function scrollChatToBottom() { const log = document.getElementById('chat-log'); if (log) log.scrollTop = log.scrollHeight; }

    // ── Tooltip ────────────────────────────────────────────────
    (function() {
        const tip = document.createElement('div'); tip.id = 'zer0-tooltip'; document.body.appendChild(tip);
        let current = null;
        const OX = 14, OY = -38;
        const show = (el, x, y) => { const n = el.getAttribute('data-fullname'); if (!n) return; tip.textContent = n; tip.classList.add('visible'); move(x,y); };
        const hide = () => { tip.classList.remove('visible'); current = null; };
        const move = (x, y) => { const tw = tip.offsetWidth; let l = x+OX, t = y+OY; if (l+tw > window.innerWidth-8) l = x-tw-OX; if (t<8) t = y+18; tip.style.left=l+'px'; tip.style.top=t+'px'; };
        document.addEventListener('mouseover', e => { const el = e.target.closest('[data-fullname]'); if (el && el!==current) { current=el; show(el,e.clientX,e.clientY); } else if (!el && current) hide(); });
        document.addEventListener('mousemove', e => { if (current) move(e.clientX,e.clientY); });
        document.addEventListener('mouseout',  e => { if (current && !e.relatedTarget?.closest('[data-fullname]')) hide(); });
    })();
})();
