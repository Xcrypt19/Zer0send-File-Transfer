(function(){
    // ── Peer registry ──────────────────────────────────────────
    const peers = new Map();          // socketId → { peerConnection, dataChannel }
    let connectedCount = 0;
    let screenSwitched = false;

    const socket = io();
    let fileCount = 0;

    let _rainInterval  = null;
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
        iceCandidatePoolSize: 10,
        bundlePolicy:  'max-bundle',
        rtcpMuxPolicy: 'require',
    };

    function generateID() {
        const seg = () => Math.floor(Math.random() * 900) + 100;
        return `${seg()}-${seg()}-${seg()}`;
    }

    // ── Toast ──────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        // Build via DOM so neither the icon class nor the message text
        // can inject markup — message often contains user-supplied filenames.
        const icon = document.createElement('i');
        const iconClass = type === 'success' ? 'check-circle'
                        : type === 'error'   ? 'exclamation-circle'
                        : 'info-circle';
        icon.className = `fas fa-${iconClass}`;
        const span = document.createElement('span');
        span.textContent = message;
        toast.appendChild(icon);
        toast.appendChild(span);
        document.getElementById('toast-container').appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideInRight 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ── Helpers ────────────────────────────────────────────────
    function formatFileSize(bytes) {
        if (!bytes) return '0 B';
        const k = 1024, s = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + s[i];
    }
    function formatTime(sec) {
        if (!isFinite(sec) || sec <= 0) return '…';
        if (sec < 60)   return Math.round(sec) + 's';
        if (sec < 3600) return Math.floor(sec/60) + 'm ' + Math.round(sec%60) + 's';
        return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';
    }
    function formatCountdown(ms) {
        if (ms <= 0) return '00:00:00';
        const t = Math.ceil(ms / 1000);
        return [Math.floor(t/3600), Math.floor((t%3600)/60), t%60]
               .map(v => String(v).padStart(2,'0')).join(':');
    }
    function updateFileCount() {
        const el = document.getElementById('file-count');
        if (el) el.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }
    function getFileIcon(fileName) {
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const m = {
            pdf:'fa-file-pdf', doc:'fa-file-word', docx:'fa-file-word',
            xls:'fa-file-excel', xlsx:'fa-file-excel', ppt:'fa-file-powerpoint', pptx:'fa-file-powerpoint',
            jpg:'fa-file-image', jpeg:'fa-file-image', png:'fa-file-image', gif:'fa-file-image',
            webp:'fa-file-image', svg:'fa-file-image',
            zip:'fa-file-archive', rar:'fa-file-archive', '7z':'fa-file-archive', tar:'fa-file-archive', gz:'fa-file-archive',
            mp3:'fa-file-audio', wav:'fa-file-audio', flac:'fa-file-audio', aac:'fa-file-audio', ogg:'fa-file-audio',
            mp4:'fa-file-video', avi:'fa-file-video', mkv:'fa-file-video', mov:'fa-file-video', webm:'fa-file-video',
            txt:'fa-file-alt', md:'fa-file-alt', json:'fa-file-code', js:'fa-file-code', ts:'fa-file-code',
            html:'fa-file-code', css:'fa-file-code', py:'fa-file-code', java:'fa-file-code',
        };
        return m[ext] || 'fa-file';
    }
    function escapeHtml(t) {
        return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ══════════════════════════════════════════════════════════
    // TRANSFER ENGINE
    // ══════════════════════════════════════════════════════════
    //
    // Architecture (per the SCTP analysis):
    //
    //   CHUNK = 16 KB
    //     Fits in a single SCTP message → no fragmentation, no head-of-line
    //     blocking inside the browser's SCTP stack.
    //
    //   Per-peer send queues (peerQueues)
    //     Each peer has its own outbound queue of packed ArrayBuffers.
    //     Slow receivers are isolated — they can't stall fast receivers.
    //
    //   Single rAF-driven flush loop
    //     requestAnimationFrame(flush) drains all peer queues each frame.
    //     This yields to ICE keepalives, SCTP ACKs, and UI between bursts —
    //     preventing the event-loop starvation that kills connections.
    //
    //   Per-peer back-pressure
    //     Pause sending to a channel when bufferedAmount > BUFFER_SOFT (2 MB).
    //     Resume via bufferedAmountLowThreshold = BUFFER_LOW (256 KB).
    //
    //   Global read cap (MAX_GLOBAL_READS = 4)
    //     Prevents memory exhaustion when many files are dropped at once.
    //
    //   Binary chunk header (24 bytes)
    //     Each binary message: [24-byte ASCII fileId][chunk data].
    //     The receiver parses the header to route chunks to the correct
    //     download by fileId, fixing multi-file interleave corruption.
    //
    const CHUNK            = 16384;    // 16 KB — one SCTP message, no fragmentation
    const QUEUE_DEPTH      = 8;        // pre-read chunks per file (8 × 16 KB = 128 KB)
    const BUFFER_SOFT      = 2097152;  // 2 MB — stop sending to a channel above this
    const BUFFER_LOW       = 262144;   // 256 KB — resume threshold
    const MAX_GLOBAL_READS = 4;        // max concurrent file reads across all transfers
    const HEADER_LEN       = 24;       // bytes reserved for ASCII fileId header

    // Per-peer outbound queues: socketId → ArrayBuffer[]
    const peerQueues = new Map();
    let   flushPending = false;

    // Global read concurrency counter
    let globalActiveReads = 0;

    // Callbacks to run when peer queues drain below BUFFER_SOFT
    const pendingResumes = new Set();

    // Pack: prepend 24-byte ASCII fileId to a binary chunk
    function packChunk(fileId, buffer) {
        const out = new Uint8Array(HEADER_LEN + buffer.byteLength);
        for (let i = 0; i < Math.min(fileId.length, HEADER_LEN); i++) {
            out[i] = fileId.charCodeAt(i);
        }
        out.set(new Uint8Array(buffer), HEADER_LEN);
        return out.buffer;
    }

    // Enqueue a packed buffer to every open peer
    function enqueueToAllPeers(packed) {
        peers.forEach(({ dataChannel }, socketId) => {
            if (!dataChannel || dataChannel.readyState !== 'open') return;
            if (!peerQueues.has(socketId)) peerQueues.set(socketId, []);
            peerQueues.get(socketId).push(packed);
        });
        scheduleFlush();
    }

    // Send a JSON control message to all open channels
    function broadcastControl(obj) {
        const str = JSON.stringify(obj);
        peers.forEach(({ dataChannel }) => {
            if (dataChannel && dataChannel.readyState === 'open') {
                try { dataChannel.send(str); } catch(e) {}
            }
        });
    }

    // Schedule the next rAF flush
    function scheduleFlush() {
        if (flushPending) return;
        flushPending = true;
        requestAnimationFrame(flush);
    }

    // rAF-driven flush: drain each peer's queue until its channel is saturated
    function flush() {
        flushPending = false;
        let anyRemaining = false;
        let anyDrained   = false;

        for (const [socketId, queue] of peerQueues.entries()) {
            const peer = peers.get(socketId);
            if (!peer) { peerQueues.delete(socketId); continue; }
            const dc = peer.dataChannel;
            if (!dc || dc.readyState !== 'open') { anyRemaining = true; continue; }

            const wasAboveSoft = dc.bufferedAmount >= BUFFER_SOFT;

            while (queue.length > 0 && dc.bufferedAmount < BUFFER_SOFT) {
                try { dc.send(queue.shift()); } catch(e) { break; }
            }

            if (queue.length === 0) {
                peerQueues.delete(socketId);
                if (wasAboveSoft) anyDrained = true;
            } else {
                anyRemaining = true;
            }
        }

        // If any queue drained below soft cap, resume stalled file reads
        if (anyDrained || peerQueues.size === 0) {
            if (pendingResumes.size > 0) {
                const toRun = Array.from(pendingResumes);
                pendingResumes.clear();
                toRun.forEach(fn => fn());
            }
        }

        if (anyRemaining) scheduleFlush();
    }

    // True if all peer queues are too large to accept more data
    function allPeersSaturated() {
        let hasPeer = false;
        for (const [socketId] of peers.entries()) {
            hasPeer = true;
            const q = peerQueues.get(socketId);
            if (!q || q.length * CHUNK < BUFFER_SOFT) return false; // at least one peer has room
        }
        return hasPeer; // only saturated if we have peers and all are full
    }

    // ── Per-receiver chat colours ──────────────────────────────
    // Each distinct alias (or socketId fallback) gets a stable colour so the
    // sender can instantly tell which receiver sent a message.
    const ALIAS_COLOURS = [
        '#48ecc8', // teal
        '#f59e0b', // amber
        '#a78bfa', // violet
        '#fb7185', // rose
        '#34d399', // emerald
        '#60a5fa', // blue
        '#f97316', // orange
        '#e879f9', // fuchsia
    ];
    const aliasColourMap = new Map(); // alias → CSS colour string
    let   aliasColourIdx = 0;

    function getAliasColour(alias) {
        if (!aliasColourMap.has(alias)) {
            aliasColourMap.set(alias, ALIAS_COLOURS[aliasColourIdx % ALIAS_COLOURS.length]);
            aliasColourIdx++;
        }
        return aliasColourMap.get(alias);
    }

    // ── Connection UI ──────────────────────────────────────────
    function updateConnectionUI() {
        const txt   = document.getElementById('connection-text');
        const si    = document.querySelector('.status-indicator');
        const badge = document.getElementById('user-count-badge');
        if (connectedCount > 0) {
            if (txt) txt.textContent = `${connectedCount} receiver${connectedCount !== 1 ? 's' : ''} connected`;
            if (si)  { si.classList.remove('waiting','disconnected'); si.classList.add('connected'); }
        } else {
            if (txt) txt.textContent = 'Waiting for receiver…';
            if (si)  { si.classList.remove('connected','disconnected'); si.classList.add('waiting'); }
        }
        if (badge) badge.textContent = connectedCount + ' online';
    }

    // ── Users panel ────────────────────────────────────────────
    function renderUserRow(socketId, alias) {
        const list = document.getElementById('users-list');
        if (!list || document.getElementById('user-row-' + socketId)) return;
        const msg = document.getElementById('no-users-msg');
        if (msg) msg.style.display = 'none';

        const row = document.createElement('div');
        row.className = 'user-row';
        row.id = 'user-row-' + socketId;

        // Build the row via DOM — never via innerHTML — so neither the alias nor
        // the socketId can break out of their text context and inject markup or JS.
        const info = document.createElement('div');
        info.className = 'user-row-info';
        const dot = document.createElement('span');
        dot.className = 'user-dot';
        const aliasSpan = document.createElement('span');
        aliasSpan.className = 'user-alias';
        aliasSpan.textContent = alias;
        info.appendChild(dot);
        info.appendChild(aliasSpan);

        const btn = document.createElement('button');
        btn.className = 'kick-btn';
        // Store the ID in a data attribute — never interpolated into JS string context.
        btn.dataset.socketId = socketId;
        btn.innerHTML = '<i class="fas fa-user-slash"></i> Kick';
        btn.addEventListener('click', function() {
            window.kickReceiver(this.dataset.socketId);
        });

        row.appendChild(info);
        row.appendChild(btn);
        list.appendChild(row);
    }
    function removeUserRow(socketId) {
        const row = document.getElementById('user-row-' + socketId);
        if (!row) return;
        row.style.opacity = '0';
        row.style.transition = 'opacity 0.3s';
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
            try { peer.dataChannel && peer.dataChannel.close(); } catch(e) {}
            try { peer.peerConnection.close(); } catch(e) {}
            peers.delete(socketId);
        }
        peerQueues.delete(socketId);
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
            if (el) {
                el.textContent = formatCountdown(rem);
                el.style.color = rem < 300000 ? '#ff4444' : rem < 900000 ? '#f59e0b' : '#40c21c';
            }
            if (rem <= 0) { clearInterval(expiryTimer); burnSession('Session expired — link self-destructed.'); }
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
        if (!screen || !canvas || !fillEl || !statusEl || !dotsEl) return;
        const dots    = Array.from(dotsEl.children);
        const total   = dots.length;
        const palette = ['#40c21c','#57d42e','#84f163','#48ecc8','#1eff00','#057a0f'];
        const msgs    = ['room created','broadcasting room id','awaiting peer','listening for receiver','standing by','waiting for receiver'];
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const ctx = canvas.getContext('2d');
            canvas.width  = screen.offsetWidth  || 800;
            canvas.height = screen.offsetHeight || 600;
            const cols  = Math.floor(canvas.width / 18);
            const drops = Array.from({length: cols}, () => Math.random() * -60);
            _rainInterval = setInterval(() => {
                ctx.fillStyle = 'rgba(6,26,8,0.15)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                for (let i = 0; i < drops.length; i++) {
                    const bit    = Math.random() > 0.5 ? '1' : '0';
                    const bright = drops[i] * 18 > canvas.height * 0.55;
                    ctx.fillStyle   = bright ? palette[Math.floor(Math.random()*2)] : palette[2 + Math.floor(Math.random()*4)];
                    ctx.font        = (Math.random() > 0.8 ? 13 : 10) + "px 'Share Tech Mono', monospace";
                    ctx.globalAlpha = bright ? 0.15 + Math.random()*0.2 : 0.05 + Math.random()*0.12;
                    ctx.fillText(bit, i * 18, drops[i] * 18);
                    ctx.globalAlpha = 1;
                    if (drops[i] * 18 > canvas.height && Math.random() > 0.96) drops[i] = 0;
                    drops[i] += 0.13 + Math.random() * 0.15;
                }
            }, 100);
        }));
        let t = 0, progress = 0, lastMsg = '';
        _pulseInterval = setInterval(() => {
            t++;
            const target = 55 + Math.sin(t * 0.05) * 7;
            progress = progress < target ? Math.min(progress + 0.5, target) : Math.max(progress - 0.15, target);
            fillEl.style.width = progress + '%';
            const lit = Math.floor((progress / 100) * total);
            dots.forEach((d, i) => { d.className = 'ldot' + (i < lit ? ' lit' : '') + (i === lit ? ' active' : ''); });
            const idx = Math.floor(t / 30) % msgs.length;
            if (msgs[idx] !== lastMsg) {
                statusEl.style.opacity = '0';
                setTimeout(() => { statusEl.textContent = msgs[idx]; statusEl.style.opacity = '1'; lastMsg = msgs[idx]; }, 300);
            }
        }, 100);
    }
    function finishLoader(onComplete) {
        clearInterval(_rainInterval);
        clearInterval(_pulseInterval);
        const fillEl   = document.getElementById('loader-fill');
        const statusEl = document.getElementById('loader-status');
        if (!fillEl || !statusEl) { if (onComplete) onComplete(); return; }
        const dots  = Array.from((document.getElementById('loader-dots') || {children:[]}).children);
        const total = dots.length;
        statusEl.style.opacity = '0';
        setTimeout(() => { statusEl.textContent = 'connected'; statusEl.style.opacity = '1'; }, 300);
        let p = parseFloat(fillEl.style.width) || 0;
        const sweep = setInterval(() => {
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
        if (!isOpen) setTimeout(() => { const i = document.getElementById('mk-input-field'); if (i) i.focus(); }, 320);
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
        setTimeout(() => { const b = document.getElementById('mk-body'); if (b) b.classList.remove('open'); if (toggle) toggle.classList.remove('open'); }, 1800);
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
    document.addEventListener('DOMContentLoaded', () => {
        const i = document.getElementById('mk-input-field');
        if (i) i.addEventListener('keydown', e => { if (e.key === 'Enter') window.applyPassphrase(); });
    });

    // ── Create Room ────────────────────────────────────────────
    document.querySelector("#sender-start-con-btn").addEventListener("click", function() {
        const joinID = generateID();
        currentRoomUID = joinID;
        const ec = document.querySelector('input[name="expiry"]:checked');
        const eh = ec ? parseInt(ec.value) : 24;
        expiryMs = Date.now() + eh * 3600000;
        const el = eh === 1 ? '1 hour' : eh === 24 ? '24 hours' : '7 days';
        // Build the Room ID block via DOM so the ID is never treated as markup.
        const joinIdEl = document.querySelector('#join-id');
        joinIdEl.innerHTML = '';
        const label = document.createElement('b');
        label.innerHTML = '<i class="fas fa-key"></i> Room ID';
        const idSpan = document.createElement('span');
        idSpan.textContent = joinID;
        idSpan.addEventListener('click', () => copyToClipboard(idSpan.textContent));
        const hint = document.createElement('p');
        hint.style.cssText = 'color:var(--text-secondary);font-size:0.75rem;margin-top:0.5rem;';
        hint.innerHTML = '<i class="fas fa-copy"></i> Click to copy';
        joinIdEl.appendChild(label);
        joinIdEl.appendChild(idSpan);
        joinIdEl.appendChild(hint);
        const eb = document.getElementById('expiry-badge');
        if (eb) { eb.style.display = 'flex'; document.getElementById('expiry-label').textContent = `Self-destructs in ${el}`; }
        socket.emit("sender-join", { uid: joinID, masterKey: passphrase, expiryMs });
        showToast(`Room created! Expires in ${el}.${passphrase ? ' Passphrase auth enabled.' : ''}`, 'success');
        const si = document.querySelector('.status-indicator');
        if (si) { si.classList.remove('connected','disconnected'); si.classList.add('waiting'); }
    });
    window.copyToClipboard = text => navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));

    // ── Socket: new receiver connected ─────────────────────────
    socket.on("init", function(receiverSocketId) {
        sessionActive = true;
        const pc = new RTCPeerConnection(configuration);

        // Ordered + reliable. No maxRetransmits → reliable delivery.
        const dc = pc.createDataChannel("fileTransfer", { ordered: true });

        // Set low-water threshold: fires onbufferedamountlow when buffer drops here
        dc.bufferedAmountLowThreshold = BUFFER_LOW;

        peers.set(receiverSocketId, { peerConnection: pc, dataChannel: dc });

        dc.onopen = function() {
            connectedCount++;
            updateConnectionUI();
            showToast('New receiver connected!', 'success');
            dc.send(JSON.stringify({ type: 'session-meta', masterKey: passphrase, expiryMs, expiryLabel: getExpiryLabel() }));
            if (connectedCount === 1) startExpiryCountdown();
        };

        dc.onmessage = function(event) {
            if (typeof event.data === 'string') {
                let msg;
                try { msg = JSON.parse(event.data); } catch(e) { return; }
                if (msg.type === 'chat') {
                    // Use the alias the receiver chose; fall back to a short socket tag
                    const alias  = msg.alias && msg.alias !== 'Receiver'
                                    ? msg.alias
                                    : 'Receiver #' + receiverSocketId.slice(-4).toUpperCase();
                    const colour = getAliasColour(alias);
                    appendChatMessage(msg.text, 'them', alias, colour);
                }
            }
        };

        // This channel drained below the low-water mark → kick the flush loop
        // and resume any file reads that were waiting on this peer
        dc.onbufferedamountlow = function() {
            scheduleFlush();
            // Also kick any pending reads waiting for peer queue space
            if (pendingResumes.size > 0) {
                const toRun = Array.from(pendingResumes);
                pendingResumes.clear();
                toRun.forEach(fn => fn());
            }
        };

        // Only treat as a real disconnect on hard failure/closure
        dc.onclose = function() {
            const pcState = pc.connectionState;
            if (pcState === 'failed' || pcState === 'closed') {
                cleanupPeer(receiverSocketId);
            }
        };

        pc.onconnectionstatechange = function() {
            const s = pc.connectionState;
            if (s === 'failed') {
                pc.restartIce();
                showToast('Connection unstable — attempting ICE restart…', 'info');
            } else if (s === 'closed') {
                cleanupPeer(receiverSocketId);
            }
            // 'disconnected' is transient — ICE will auto-recover
        };

        pc.onsignalingstatechange = function() {
            if (pc.signalingState === 'closed') cleanupPeer(receiverSocketId);
        };

        pc.onicecandidate = e => {
            if (e.candidate) socket.emit("candidate", { candidate: e.candidate, uid: receiverSocketId });
        };

        pc.createOffer()
            .then(o  => pc.setLocalDescription(o))
            .then(() => socket.emit("offer", { offer: pc.localDescription, uid: receiverSocketId }));

        if (!screenSwitched) {
            screenSwitched = true;
            document.querySelector(".join-screen").classList.remove("active");
            document.querySelector(".fs-screen").classList.add("active");
        }
    });

    function cleanupPeer(socketId) {
        if (!peers.has(socketId)) return;
        peers.delete(socketId);
        peerQueues.delete(socketId);
        connectedCount = Math.max(0, connectedCount - 1);
        updateConnectionUI();
        removeUserRow(socketId);
        showToast('A receiver disconnected.', 'error');
    }

    function getExpiryLabel() {
        const r = expiryMs - Date.now();
        return r > 20*3600000 ? '7 days' : r > 2*3600000 ? '24 hours' : '1 hour';
    }

    socket.on("answer", d => {
        const p = peers.get(d.uid);
        if (p) p.peerConnection.setRemoteDescription(d.answer);
    });
    socket.on("candidate", d => {
        const p = peers.get(d.uid);
        if (p) p.peerConnection.addIceCandidate(d.candidate).catch(() => {});
    });
    socket.on("receiver-list", function(data) {
        const badge = document.getElementById('user-count-badge');
        if (badge) badge.textContent = data.count + ' online';
        const existing = new Set(Array.from(document.querySelectorAll('.user-row')).map(el => el.id.replace('user-row-','')));
        const fresh    = new Set(data.receivers.map(r => r.socketId));
        existing.forEach(sid => { if (!fresh.has(sid)) removeUserRow(sid); });
        data.receivers.forEach(r => { if (!existing.has(r.socketId)) renderUserRow(r.socketId, r.alias); });
    });
    socket.on("receiver-left", d => removeUserRow(d.socketId));

    // ── Drag & Drop ────────────────────────────────────────────
    const dropArea    = document.getElementById('drop-area');
    const fileInput   = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');

    ['dragenter','dragover','dragleave','drop'].forEach(ev =>
        dropArea.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, false));
    ['dragenter','dragover'].forEach(ev =>
        dropArea.addEventListener(ev, () => dropArea.classList.add('dragover'), false));
    ['dragleave','drop'].forEach(ev =>
        dropArea.addEventListener(ev, () => dropArea.classList.remove('dragover'), false));

    function hasOpenChannel() {
        for (const { dataChannel: dc } of peers.values())
            if (dc && dc.readyState === 'open') return true;
        return false;
    }

    dropArea.addEventListener('drop', async function(e) {
        if (!hasOpenChannel()) { showToast('No receivers connected yet.', 'error'); return; }
        const items = Array.from(e.dataTransfer.items || []);
        if (items.some(i => i.webkitGetAsEntry?.()?.isDirectory)) {
            for (const item of items) {
                const entry = item.webkitGetAsEntry?.();
                if (entry) await traverseEntry(entry, '');
            }
        } else {
            Array.from(e.dataTransfer.files).forEach(f => sendFile(f, f.name));
        }
    }, false);

    async function traverseEntry(entry, basePath) {
        if (entry.isFile) {
            return new Promise(res => entry.file(f => {
                sendFile(f, basePath ? basePath + '/' + entry.name : entry.name);
                res();
            }, res));
        }
        if (entry.isDirectory) {
            const dirPath = basePath ? basePath + '/' + entry.name : entry.name;
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

    // Global set of fillQueue callbacks waiting for a free read slot.
    // When any read completes and globalActiveReads drops, we drain this.
    const pendingFillQueues = new Set();

    function onReadSlotFreed() {
        if (pendingFillQueues.size === 0) return;
        const toRun = Array.from(pendingFillQueues);
        pendingFillQueues.clear();
        toRun.forEach(fn => fn());
    }

    // ── sendFile — 16 KB chunks, per-peer queues, rAF flush ────
    function sendFile(file, relativePath) {
        const fileId      = Date.now() + '-' + Math.floor(Math.random() * 1e9);
        const displayName = relativePath || file.name;

        let readAhead      = 0;
        let sentBytes      = 0;
        let localQueue     = [];
        let activeReads    = 0;
        let isCancelled    = false;
        const startTime    = Date.now();

        // ── Send metadata ──────────────────────────────────────
        broadcastControl({
            type: 'metadata',
            data: { fileId, fileName: file.name, fileSize: file.size,
                    fileType: file.type || 'application/octet-stream',
                    relativePath: relativePath || '' }
        });

        // ── UI row ─────────────────────────────────────────────
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
            </div>`;
        document.querySelector('.files-list').appendChild(row);
        fileCount++;
        updateFileCount();

        row.querySelector('.remove-file-btn').addEventListener('click', function() {
            isCancelled = true;
            pendingFillQueues.delete(fillQueue);
            broadcastControl({ type: 'remove-file', fileId });
            row.style.transition = 'opacity 0.25s, transform 0.25s';
            row.style.opacity    = '0';
            row.style.transform  = 'translateX(16px)';
            setTimeout(() => { row.remove(); fileCount--; updateFileCount(); }, 260);
            showToast(`${file.name} removed.`, 'info');
        });

        // rAF-throttled progress UI
        let rafPending = false;
        function scheduleRefreshUI() {
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                const pct = file.size > 0 ? Math.min(Math.round((sentBytes / file.size) * 100), 100) : 100;
                row.style.setProperty('--pct', pct + '%');
                const el = row.querySelector('.file-card-pct');
                if (el) el.textContent = pct + '%';
            });
        }

        // ── Mark this file complete and notify receivers ───────
        function finishFile() {
            const dur = Math.max((Date.now() - startTime) / 1000, 0.001);
            const spd = file.size > 0 ? (file.size / dur / 1048576).toFixed(2) : '0.00';
            broadcastControl({ type: 'done', fileId });
            row.style.setProperty('--pct', '100%');
            row.classList.add('send-complete');
            const el = row.querySelector('.file-card-pct');
            if (el) el.textContent = '✓';
            showToast(`${file.name} sent — ${spd} MB/s (${formatTime(dur)})`, 'success');
        }

        // ── Handle zero-byte files (common in folder structures) ─
        // fillQueue would never start since readAhead(0) < file.size(0) is false,
        // so the 'done' message would never be sent and the receiver stalls at 0%.
        if (file.size === 0) {
            finishFile();
            return;
        }

        // ── Enqueue all pre-read chunks to peer queues ─────────
        function flushLocalQueue() {
            if (isCancelled) return;

            while (localQueue.length > 0) {
                if (allPeersSaturated()) {
                    pendingResumes.add(flushLocalQueue);
                    return;
                }
                const buf    = localQueue.shift();
                const packed = packChunk(fileId, buf);
                enqueueToAllPeers(packed);
                sentBytes += buf.byteLength;
                scheduleRefreshUI();
            }

            if (activeReads === 0 && localQueue.length === 0 && sentBytes >= file.size) {
                finishFile();
            } else {
                fillQueue();
            }
        }

        // ── Read ahead: overlap disk I/O with network sends ────
        function fillQueue() {
            if (isCancelled) return;
            while (
                globalActiveReads < MAX_GLOBAL_READS &&
                activeReads + localQueue.length < QUEUE_DEPTH &&
                readAhead < file.size
            ) {
                const start = readAhead;
                const end   = Math.min(readAhead + CHUNK, file.size);
                readAhead   = end;
                activeReads++;
                globalActiveReads++;

                file.slice(start, end).arrayBuffer()
                    .then(buf => {
                        activeReads--;
                        globalActiveReads--;
                        if (isCancelled) { onReadSlotFreed(); return; }
                        localQueue.push(buf);
                        onReadSlotFreed(); // wake any files waiting for a read slot
                        flushLocalQueue();
                    })
                    .catch(() => {
                        activeReads--;
                        globalActiveReads--;
                        onReadSlotFreed();
                        showToast(`Read error on "${file.name}"`, 'error');
                    });
            }

            // If we couldn't start any reads because the global cap is full,
            // register this file's fillQueue to be retried when a slot frees up.
            if (!isCancelled && readAhead < file.size &&
                globalActiveReads >= MAX_GLOBAL_READS &&
                activeReads + localQueue.length < QUEUE_DEPTH) {
                pendingFillQueues.add(fillQueue);
            }
        }

        fillQueue();
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
        if (!hasOpenChannel()) { showToast('Not connected — cannot send message.', 'error'); return; }
        broadcastControl({ type: 'chat', text, alias: 'Sender' });
        appendChatMessage(text, 'me', 'You');
        input.value = '';
    };
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && document.activeElement?.id === 'chat-input') window.sendChatMessage();
    });

    function updateChatBadge() {
        const badge = document.getElementById('chat-badge');
        if (!badge) return;
        if (unreadCount > 0) { badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount); badge.classList.add('visible'); }
        else { badge.textContent = ''; badge.classList.remove('visible'); }
    }
    function appendChatMessage(text, side, alias, colour) {
        const log = document.getElementById('chat-log');
        if (!log) return;
        const empty = log.querySelector('.chat-empty');
        if (empty) empty.remove();
        const div = document.createElement('div');
        div.className = 'chat-msg ' + side;
        // For incoming messages, colour the alias uniquely per receiver
        const aliasStyle = (side === 'them' && colour)
            ? ` style="color:${colour}"`
            : '';
        div.innerHTML = `
            <div class="chat-alias"${aliasStyle}>${escapeHtml(alias)}</div>
            <div class="chat-bubble">${escapeHtml(text)}</div>
            <div class="chat-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>`;
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

    // ── Tooltip ────────────────────────────────────────────────
    (function() {
        const tip = document.createElement('div');
        tip.id = 'zer0-tooltip';
        document.body.appendChild(tip);
        let current = null;
        const OX = 14, OY = -38;
        const show = (el, x, y) => { const n = el.getAttribute('data-fullname'); if (!n) return; tip.textContent = n; tip.classList.add('visible'); move(x,y); };
        const hide = () => { tip.classList.remove('visible'); current = null; };
        const move = (x, y) => { const tw = tip.offsetWidth; let l = x+OX, t = y+OY; if (l+tw > window.innerWidth-8) l = x-tw-OX; if (t < 8) t = y+18; tip.style.left = l+'px'; tip.style.top = t+'px'; };
        document.addEventListener('mouseover', e => { const el = e.target.closest('[data-fullname]'); if (el && el!==current) { current = el; show(el, e.clientX, e.clientY); } else if (!el && current) hide(); });
        document.addEventListener('mousemove', e => { if (current) move(e.clientX, e.clientY); });
        document.addEventListener('mouseout',  e => { if (current && !e.relatedTarget?.closest('[data-fullname]')) hide(); });
    })();
})();
