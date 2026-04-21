(function(){
    const socket = io();
    let peerConnection;
    let activeDownloads = new Map();
    let fileCount = 0;

    // ── Binary chunk unpacking ─────────────────────────────────
    // The sender prepends a 24-byte ASCII fileId header to every binary message.
    // We parse it here to route each chunk to the correct download without
    // relying on "current file" state, which breaks when multiple files are
    // in flight simultaneously.
    const HEADER_LEN = 24;
    function unpackChunk(data) {
        const view = new Uint8Array(data);
        let fileId = '';
        for (let i = 0; i < HEADER_LEN; i++) {
            if (view[i] === 0) break;
            fileId += String.fromCharCode(view[i]);
        }
        return { fileId, buffer: data.slice(HEADER_LEN) };
    }

    let _rainInterval = null;
    let _pulseInterval = null;

    // ── Session state ──────────────────────────────────────────
    let expiryTimer     = null;
    let chatOpen        = false;
    let sessionVerified = false;
    let unreadCount     = 0;
    let senderSocketId_ = null; // stored for ICE restart

    // Completed blobs keyed by fileId for "Download All as ZIP"
    const completedFiles = new Map();

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    // ── Toast ──────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        // DOM construction — message is always plain text, never markup
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
        setTimeout(() => { toast.style.animation = 'slideInRight 0.3s ease reverse'; setTimeout(() => toast.remove(), 300); }, 3000);
    }

    // ── Helpers ────────────────────────────────────────────────
    function updateFileCount() {
        const el = document.getElementById('file-count');
        if (el) el.textContent = `${fileCount} file${fileCount!==1?'s':''}`;
    }
    function getFileIcon(fn) {
        const ext = (fn.split('.').pop()||'').toLowerCase();
        const m={pdf:'fa-file-pdf',doc:'fa-file-word',docx:'fa-file-word',xls:'fa-file-excel',xlsx:'fa-file-excel',ppt:'fa-file-powerpoint',pptx:'fa-file-powerpoint',jpg:'fa-file-image',jpeg:'fa-file-image',png:'fa-file-image',gif:'fa-file-image',webp:'fa-file-image',svg:'fa-file-image',zip:'fa-file-archive',rar:'fa-file-archive','7z':'fa-file-archive',tar:'fa-file-archive',gz:'fa-file-archive',mp3:'fa-file-audio',wav:'fa-file-audio',flac:'fa-file-audio',aac:'fa-file-audio',ogg:'fa-file-audio',mp4:'fa-file-video',avi:'fa-file-video',mkv:'fa-file-video',mov:'fa-file-video',webm:'fa-file-video',txt:'fa-file-alt',md:'fa-file-alt',json:'fa-file-code',js:'fa-file-code',ts:'fa-file-code',html:'fa-file-code',css:'fa-file-code',py:'fa-file-code'};
        return m[ext]||'fa-file';
    }
    function formatFileSize(bytes) {
        if (!bytes) return '0 B';
        const k=1024, s=['B','KB','MB','GB','TB'], i=Math.floor(Math.log(bytes)/Math.log(k));
        return (bytes/Math.pow(k,i)).toFixed(i===0?0:1)+' '+s[i];
    }
    function formatTime(sec) {
        if (!isFinite(sec)||sec<=0) return '…';
        if (sec<60) return Math.round(sec)+'s';
        if (sec<3600) return Math.floor(sec/60)+'m '+Math.round(sec%60)+'s';
        return Math.floor(sec/3600)+'h '+Math.floor((sec%3600)/60)+'m';
    }
    function formatCountdown(ms) {
        if (ms<=0) return '00:00:00';
        const t=Math.ceil(ms/1000);
        return [Math.floor(t/3600),Math.floor((t%3600)/60),t%60].map(v=>String(v).padStart(2,'0')).join(':');
    }
    function escapeHtml(t) {
        return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Expiry countdown ───────────────────────────────────────
    function startExpiryCountdown(expiryMs) {
        const tick = () => {
            const rem = expiryMs - Date.now();
            const el  = document.getElementById('expiry-countdown');
            if (el) { el.textContent = formatCountdown(rem); el.style.color = rem<300000?'#ff4444':rem<900000?'#f59e0b':'#40c21c'; }
            if (rem <= 0) { clearInterval(expiryTimer); burnSession('Session expired — link has self-destructed.'); }
        };
        tick(); expiryTimer = setInterval(tick, 1000);
    }
    function burnSession(reason) {
        clearInterval(expiryTimer);
        showToast(reason||'Session terminated.', 'error');
        setTimeout(()=>location.reload(), 2500);
    }

    // ── Loading screen ─────────────────────────────────────────
    function initLoader() {
        const screen=document.getElementById('loader-screen'), canvas=document.getElementById('loader-rain');
        const fillEl=document.getElementById('loader-fill'), statusEl=document.getElementById('loader-status');
        const dotsEl=document.getElementById('loader-dots');
        if (!screen||!canvas||!fillEl||!statusEl||!dotsEl) return;
        const dots=Array.from(dotsEl.children), total=dots.length;
        const palette=['#40c21c','#57d42e','#84f163','#48ecc8','#1eff00','#057a0f'];
        const msgs=['connecting to room','locating sender','establishing peer connection','webrtc handshake','securing channel','almost there'];
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
            const ctx=canvas.getContext('2d');
            canvas.width=screen.offsetWidth||800; canvas.height=screen.offsetHeight||600;
            const cols=Math.floor(canvas.width/18), drops=Array.from({length:cols},()=>Math.random()*-60);
            _rainInterval=setInterval(()=>{
                ctx.fillStyle='rgba(6,26,8,0.15)'; ctx.fillRect(0,0,canvas.width,canvas.height);
                for(let i=0;i<drops.length;i++){
                    const bit=Math.random()>0.5?'1':'0', bright=drops[i]*18>canvas.height*0.55;
                    ctx.fillStyle=bright?palette[Math.floor(Math.random()*2)]:palette[2+Math.floor(Math.random()*4)];
                    ctx.font=(Math.random()>0.8?13:10)+"px 'Share Tech Mono',monospace";
                    ctx.globalAlpha=bright?0.15+Math.random()*0.2:0.05+Math.random()*0.12;
                    ctx.fillText(bit,i*18,drops[i]*18); ctx.globalAlpha=1;
                    if(drops[i]*18>canvas.height&&Math.random()>0.96) drops[i]=0;
                    drops[i]+=0.3+Math.random()*0.35;
                }
            },60);
        }));
        let t=0, progress=0, lastMsg='';
        _pulseInterval=setInterval(()=>{
            t++;
            const target=55+Math.sin(t*0.05)*7;
            progress=progress<target?Math.min(progress+0.5,target):Math.max(progress-0.15,target);
            fillEl.style.width=progress+'%';
            const lit=Math.floor((progress/100)*total);
            dots.forEach((d,i)=>{d.className='ldot'+(i<lit?' lit':'')+(i===lit?' active':'');});
            const idx=Math.floor(t/28)%msgs.length;
            if(msgs[idx]!==lastMsg){ statusEl.style.opacity='0'; setTimeout(()=>{statusEl.textContent=msgs[idx];statusEl.style.opacity='1';lastMsg=msgs[idx];},300); }
        },100);
    }
    function finishLoader(onComplete) {
        clearInterval(_rainInterval); clearInterval(_pulseInterval);
        const fillEl=document.getElementById('loader-fill'), statusEl=document.getElementById('loader-status');
        if(!fillEl||!statusEl){if(onComplete)onComplete();return;}
        const dots=Array.from((document.getElementById('loader-dots')||{children:[]}).children), total=dots.length;
        statusEl.style.opacity='0';
        setTimeout(()=>{statusEl.textContent='connected';statusEl.style.opacity='1';},300);
        let p=parseFloat(fillEl.style.width)||0;
        const sw=setInterval(()=>{
            p=Math.min(p+3,100); fillEl.style.width=p+'%';
            const lit=Math.floor((p/100)*total);
            dots.forEach((d,i)=>{d.className='ldot'+(i<lit?' lit':'')+(i===lit?' active':'');});
            if(p>=100){clearInterval(sw);setTimeout(onComplete,500);}
        },18);
    }

    // ── Connect button ─────────────────────────────────────────
    // myAlias is stored at module scope so sendChatMessage can use it
    let myAlias = '';

    document.querySelector("#receiver-start-con-btn").addEventListener("click", function(){
        const joinID = document.querySelector("#join-id").value.trim();
        if (!joinID.length) { showToast('Please enter a Room ID', 'error'); return; }
        const aliasInput = document.querySelector("#receiver-alias");
        myAlias = (aliasInput && aliasInput.value.trim()) || '';
        socket.emit("receiver-join", { uid: joinID, alias: myAlias });
        showToast('Connecting to room…', 'info');
    });

    // ── Socket: init ───────────────────────────────────────────
    socket.on("init", function(senderSocketId){
        showToast('Connected to sender!', 'success');
        senderSocketId_ = senderSocketId;
        document.querySelector(".join-screen").classList.remove("active");
        document.querySelector(".fs-screen").classList.add("active");

        peerConnection = new RTCPeerConnection(configuration);

        peerConnection.ondatachannel = function(event){
            const dataChannel = event.channel;

            dataChannel.onmessage = function(event){
                if (typeof event.data === 'string') {
                    const msg = JSON.parse(event.data);
                    if      (msg.type === 'metadata')     startFileReceive(msg.data);
                    else if (msg.type === 'done')         completeFileReceive(msg.fileId);
                    else if (msg.type === 'remove-file')  removeFileItem(msg.fileId);
                    else if (msg.type === 'session-meta') handleSessionMeta(msg, dataChannel);
                    else if (msg.type === 'chat')         appendChatMessage(msg.text, 'them', msg.alias||'Sender');
                } else {
                    handleFileChunk(event.data);
                }
            };

            dataChannel.onopen  = function(){ console.log('[zer0] data channel open'); };

            // ── Only react to close if the PC itself is permanently dead ──
            dataChannel.onclose = function() {
                const s = peerConnection ? peerConnection.connectionState : 'closed';
                // 'disconnected' is transient — ICE may recover. Only act on hard failures.
                if (s === 'failed' || s === 'closed') showSenderDisconnected();
            };

            window._dataChannel = dataChannel;
        };

        // ── Connection state: treat 'disconnected' as transient ───
        // 'disconnected' fires when ICE temporarily loses packets (very common
        // under load). It auto-recovers most of the time. Only 'failed' or
        // 'closed' means the session is truly dead.
        peerConnection.onconnectionstatechange = function() {
            const s = peerConnection.connectionState;
            console.log('[zer0] connection state:', s);

            if (s === 'disconnected') {
                // Show a soft warning but do NOT end the session yet.
                // ICE will attempt to recover for up to ~30s automatically.
                const ct = document.getElementById('connection-text');
                if (ct) ct.textContent = 'Connection interrupted — reconnecting…';
                const si = document.querySelector('.status-indicator');
                if (si) { si.classList.remove('connected'); si.classList.add('waiting'); }
                showToast('Connection interrupted — attempting recovery…', 'info');
            } else if (s === 'connected' || s === 'completed') {
                const ct = document.getElementById('connection-text');
                if (ct) ct.textContent = 'Connected to sender';
                const si = document.querySelector('.status-indicator');
                if (si) { si.classList.remove('waiting','disconnected'); si.classList.add('connected'); }
            } else if (s === 'failed' || s === 'closed') {
                showSenderDisconnected();
            }
        };

        peerConnection.onicecandidate = function(event){
            if (event.candidate) socket.emit("candidate", { candidate: event.candidate, uid: senderSocketId });
        };
    });

    // ── Kicked by sender ───────────────────────────────────────
    socket.on("kicked", function(data) {
        const overlay = document.createElement('div');
        overlay.id = 'kicked-overlay';
        overlay.innerHTML = `
            <div class="sdo-card">
                <div class="sdo-icon" style="color:#ef4444;"><i class="fas fa-user-slash"></i></div>
                <div class="sdo-title" style="color:#ef4444;">REMOVED FROM SESSION</div>
                <div class="sdo-body">
                    ${escapeHtml(data.reason||'The sender has removed you from this room.')}
                    <br><br>Any completed files can still be downloaded.
                </div>
                <div class="sdo-actions">
                    <button class="sdo-btn-dismiss" id="kicked-dismiss"><i class="fas fa-download"></i> Stay &amp; Download</button>
                    <button class="sdo-btn-reload"><i class="fas fa-rotate-right"></i> New Session</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.sdo-btn-reload').addEventListener('click', ()=>location.reload());
        overlay.querySelector('#kicked-dismiss').addEventListener('click', ()=>{
            overlay.style.transition='opacity 0.3s'; overlay.style.opacity='0';
            setTimeout(()=>overlay.remove(), 310);
        });
        const si=document.querySelector('.status-indicator');
        if(si){si.classList.remove('waiting','connected');si.classList.add('disconnected');}
        const ct=document.getElementById('connection-text');
        if(ct) ct.textContent='Removed by sender';
        showToast('You have been removed from the room.', 'error');
    });

    // ── Session metadata ───────────────────────────────────────
    let _pendingMeta=null, _activeDataChannel=null;

    function handleSessionMeta(meta, dataChannel) {
        _activeDataChannel = dataChannel;
        if (meta.masterKey) {
            _pendingMeta = meta;
            const gate = document.getElementById('passphrase-gate');
            if (gate) gate.classList.add('active');
            setTimeout(()=>{const i=document.getElementById('pg-input');if(i)i.focus();},350);
        } else {
            activateSession(meta, dataChannel);
        }
    }

    window.submitPassphraseGate = function() {
        const inp=document.getElementById('pg-input'), errEl=document.getElementById('pg-error');
        const attEl=document.getElementById('pg-attempts'), btn=document.getElementById('pg-submit-btn');
        if (!inp||!_pendingMeta) return;
        const entered=inp.value.trim();
        if (!entered){errEl.textContent='Please enter the passphrase.';inp.focus();return;}
        if (entered===_pendingMeta.masterKey) {
            errEl.textContent='';
            btn.innerHTML='<i class="fas fa-check-circle"></i>&nbsp; Verified!';
            btn.classList.add('success'); inp.disabled=true;
            setTimeout(()=>{
                const g=document.getElementById('passphrase-gate');if(g)g.classList.remove('active');
                activateSession(_pendingMeta,_activeDataChannel); _pendingMeta=null;
            },900);
        } else {
            inp.classList.add('shake'); inp.value='';
            setTimeout(()=>inp.classList.remove('shake'),450);
            errEl.textContent='Incorrect passphrase — try again.'; inp.focus();
            if(!window._pgAttempts) window._pgAttempts=0;
            window._pgAttempts++;
            if(window._pgAttempts>=3) attEl.textContent=`${window._pgAttempts} failed attempt${window._pgAttempts>1?'s':''}`;
            if(window._pgAttempts>=5){
                errEl.textContent='Too many failed attempts — session closed.';
                inp.disabled=true; btn.disabled=true;
                if(_activeDataChannel) _activeDataChannel.send(JSON.stringify({type:'key-rejected'}));
                setTimeout(()=>location.reload(),2500);
            }
        }
    };

    document.addEventListener('DOMContentLoaded', ()=>{
        const i=document.getElementById('pg-input');
        if(i) i.addEventListener('keydown',e=>{if(e.key==='Enter')window.submitPassphraseGate();});
    });

    function activateSession(meta, dataChannel) {
        sessionVerified=true;
        const band=document.getElementById('expiry-band');
        if(band){band.style.display='flex';const l=document.getElementById('expiry-label');if(l)l.textContent='Session self-destructs in:';}
        if(meta.expiryMs) startExpiryCountdown(meta.expiryMs);
        // escapeHtml guards expiryLabel — it comes from the sender over the data channel
        const safeLabel = escapeHtml(String(meta.expiryLabel || '...').slice(0, 32));
        const passNote  = meta.masterKey ? ' · Passphrase verified ✓' : '';
        showToast(`Session secured. Expires in ${safeLabel}${passNote}`, 'success');
        const si=document.querySelector('.status-indicator');
        if(si){si.classList.remove('waiting','disconnected');si.classList.add('connected');}
        const ct=document.getElementById('connection-text');
        if(ct) ct.textContent='Connected to sender';
    }

    // ── Metadata sanitisation ──────────────────────────────────
    // All fields come from the sender over the data channel and must be treated
    // as untrusted. We clamp lengths and strip control characters before any
    // value touches the DOM or is stored.
    function sanitiseMeta(raw) {
        const str = (v, max) => String(v || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
        return {
            fileId:       str(raw.fileId,       64).replace(/[^a-zA-Z0-9\-]/g, ''),
            fileName:     str(raw.fileName,     255) || 'unnamed',
            fileSize:     Math.max(0, parseInt(raw.fileSize) || 0),
            fileType:     str(raw.fileType,     128) || 'application/octet-stream',
            // Strip path traversal sequences from relative paths
            relativePath: str(raw.relativePath, 512).replace(/\.\.[/\\]/g, '').replace(/^[/\\]+/, ''),
        };
    }

    // ── File receiving ─────────────────────────────────────────
    function startFileReceive(rawMetadata) {
        const metadata = sanitiseMeta(rawMetadata);
        const ws=document.getElementById('waiting-section');
        if(ws) ws.style.display='none';
        const dl={
            fileId: metadata.fileId, fileName: metadata.fileName, fileSize: metadata.fileSize,
            fileType: metadata.fileType, relativePath: metadata.relativePath,
            chunks: [], receivedBytes: 0, startTime: Date.now(), completed: false
        };
        activeDownloads.set(metadata.fileId, dl);
        const displayName = dl.relativePath||dl.fileName;
        const row = document.createElement('div');
        row.classList.add('item'); row.id='file-'+metadata.fileId; row.style.setProperty('--pct','0%');
        row.innerHTML=`
            <div class="file-card-body">
                <i class="fas ${getFileIcon(metadata.fileName)} file-card-icon"></i>
                <div class="file-card-meta">
                    <div class="file-card-name" title="${escapeHtml(displayName)}" data-fullname="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                    <div class="file-card-size">${formatFileSize(metadata.fileSize)}</div>
                </div>
                <div class="file-card-pct">0%</div>
            </div>`;
        document.querySelector('.files-list').appendChild(row);
        fileCount++; updateFileCount();
        // escapeHtml guards against file names that contain angle brackets in the toast
        showToast(`Receiving ${escapeHtml(displayName)}…`, 'info');
    }

    function handleFileChunk(data) {
        // Unpack the 24-byte fileId header inserted by the sender's packChunk().
        // This routes each chunk to the correct download by fileId, fixing
        // multi-file interleave corruption.
        const { fileId, buffer } = unpackChunk(data);
        const dl = activeDownloads.get(fileId);
        if (!dl || dl.completed) return;
        dl.chunks.push(buffer);
        dl.receivedBytes += buffer.byteLength;
        const row = document.getElementById('file-'+dl.fileId);
        if (row) {
            const pct = dl.fileSize>0 ? Math.min(Math.round((dl.receivedBytes/dl.fileSize)*100),100) : 0;
            row.style.setProperty('--pct',pct+'%');
            const el=row.querySelector('.file-card-pct');
            if(el) el.textContent=pct+'%';
        }
        // Consolidate small ArrayBuffers periodically to control memory
        if (dl.chunks.length > 200) dl.chunks=[new Blob(dl.chunks,{type:dl.fileType})];
    }

    function completeFileReceive(fileId) {
        const dl = activeDownloads.get(fileId);
        if (!dl) return;
        dl.completed=true;
        const dur=Math.max((Date.now()-dl.startTime)/1000,0.001);
        const spd=(dl.fileSize/dur/1048576).toFixed(2);
        const finalBlob=new Blob(dl.chunks,{type:dl.fileType});
        completedFiles.set(fileId,{fileName:dl.fileName,relativePath:dl.relativePath,blob:finalBlob});
        updateDownloadAllBtn();
        const row=document.getElementById('file-'+fileId);
        if(row){
            row.style.setProperty('--pct','100%'); row.classList.add('download-ready');
            const el=row.querySelector('.file-card-pct');
            if(el) el.innerHTML='<i class="fas fa-arrow-down"></i>';
            row.title='Click to download';
            row.addEventListener('click',function(){
                const a=document.createElement('a');
                a.href=URL.createObjectURL(finalBlob); a.download=dl.fileName; a.click();
                URL.revokeObjectURL(a.href);
            });
        }
        // escapeHtml guards the file name — it's sender-controlled data
        showToast(`${escapeHtml(dl.relativePath||dl.fileName)} ready — ${spd} MB/s (${formatTime(dur)})`, 'success');
        activeDownloads.delete(fileId);
    }

    function removeFileItem(fileId) {
        const row=document.getElementById('file-'+fileId);
        if(row){
            row.style.transition='opacity 0.25s,transform 0.25s'; row.style.opacity='0'; row.style.transform='translateX(16px)';
            setTimeout(()=>{row.remove();fileCount--;updateFileCount();},260);
        }
        completedFiles.delete(fileId); updateDownloadAllBtn();
        showToast('A file was removed by the sender.', 'info');
    }

    // ── Download All as ZIP ────────────────────────────────────
    function updateDownloadAllBtn() {
        const btn=document.getElementById('download-all-btn');
        if(!btn) return;
        btn.style.display=completedFiles.size>=2?'inline-flex':'none';
        btn.querySelector('.dab-count').textContent=completedFiles.size+' files';
    }

    window.downloadAllAsZip = async function() {
        if (!completedFiles.size) return;
        const btn=document.getElementById('download-all-btn');
        if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Building ZIP…';}
        if (!window.JSZip) {
            await new Promise((res,rej)=>{
                const s=document.createElement('script');
                s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                // SRI prevents a compromised CDN from injecting malicious code
                s.integrity='sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==';
                s.crossOrigin='anonymous';
                s.onload=res; s.onerror=rej; document.head.appendChild(s);
            });
        }
        const zip=new window.JSZip();
        completedFiles.forEach(({fileName,relativePath,blob})=>zip.file(relativePath||fileName,blob));
        try {
            const content=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:3}});
            const a=document.createElement('a');
            a.href=URL.createObjectURL(content); a.download='zer0send-files.zip'; a.click();
            URL.revokeObjectURL(a.href);
            showToast(`Downloaded ${completedFiles.size} files as ZIP!`, 'success');
        } catch(err) { showToast('ZIP error: '+err.message,'error'); }
        finally {
            if(btn){btn.disabled=false;btn.innerHTML=`<i class="fas fa-file-archive"></i> Download All as ZIP <span class="dab-count">${completedFiles.size} files</span>`;}
        }
    };

    // ── WebRTC signalling ──────────────────────────────────────
    socket.on("offer", function(data){
        peerConnection.setRemoteDescription(data.offer)
            .then(()=>peerConnection.createAnswer())
            .then(a=>peerConnection.setLocalDescription(a))
            .then(()=>socket.emit("answer",{answer:peerConnection.localDescription,uid:data.uid}));
    });

    socket.on("candidate", data => {
        if(peerConnection) peerConnection.addIceCandidate(data.candidate).catch(()=>{});
    });
    socket.on("error", data => showToast(data.message||'Connection error','error'));

    // ── Room ID formatter ──────────────────────────────────────
    const joinIdInput = document.getElementById('join-id');
    if (joinIdInput) {
        joinIdInput.addEventListener('input', function(e) {
            let v=e.target.value.replace(/[^0-9-]/g,'');
            if(v.length>3&&v[3]!=='-') v=v.slice(0,3)+'-'+v.slice(3);
            if(v.length>7&&v[7]!=='-') v=v.slice(0,7)+'-'+v.slice(7);
            e.target.value=v.slice(0,11);
        });
    }

    // ── Secure Chat ────────────────────────────────────────────
    window.toggleChat = function() {
        chatOpen=!chatOpen;
        const panel=document.getElementById('chat-panel'), btn=document.getElementById('chat-toggle-btn');
        if(panel) panel.classList.toggle('open',chatOpen);
        if(btn) btn.classList.toggle('active',chatOpen);
        if(chatOpen){unreadCount=0;updateChatBadge();const i=document.getElementById('chat-input');if(i)i.focus();scrollChatToBottom();}
    };
    window.sendChatMessage = function() {
        const input=document.getElementById('chat-input'); if(!input) return;
        const text=input.value.trim(); if(!text) return;
        const dc=window._dataChannel;
        if(!dc||dc.readyState!=='open'){showToast('Not connected — cannot send message.','error');return;}
        // Use the alias entered at join time; fall back to a short socket-derived tag
        const displayAlias = myAlias || 'Receiver';
        dc.send(JSON.stringify({type:'chat', text, alias: displayAlias}));
        appendChatMessage(text,'me','You'); input.value='';
    };
    document.addEventListener('keydown', e=>{if(e.key==='Enter'&&document.activeElement?.id==='chat-input') window.sendChatMessage();});

    function updateChatBadge() {
        const b=document.getElementById('chat-badge'); if(!b) return;
        if(unreadCount>0){b.textContent=unreadCount>99?'99+':String(unreadCount);b.classList.add('visible');}
        else{b.textContent='';b.classList.remove('visible');}
    }
    function appendChatMessage(text, side, alias) {
        const log=document.getElementById('chat-log'); if(!log) return;
        const empty=log.querySelector('.chat-empty'); if(empty) empty.remove();
        const div=document.createElement('div'); div.className='chat-msg '+side;
        div.innerHTML=`<div class="chat-alias">${escapeHtml(alias)}</div><div class="chat-bubble">${escapeHtml(text)}</div><div class="chat-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>`;
        log.appendChild(div); scrollChatToBottom();
        if(side==='them'&&!chatOpen){
            unreadCount++; updateChatBadge();
            const btn=document.getElementById('chat-toggle-btn');
            if(btn){btn.classList.add('pulse');setTimeout(()=>btn.classList.remove('pulse'),2000);}
        }
    }
    function scrollChatToBottom(){const l=document.getElementById('chat-log');if(l)l.scrollTop=l.scrollHeight;}

    // ── Sender disconnected overlay ────────────────────────────
    let _disconnectShown=false;
    function showSenderDisconnected() {
        if(_disconnectShown) return;
        _disconnectShown=true;
        const ct=document.getElementById('connection-text');
        if(ct) ct.textContent='Sender disconnected';
        const si=document.querySelector('.status-indicator');
        if(si){si.classList.remove('waiting','connected');si.classList.add('disconnected');}
        const now=new Date();
        const overlay=document.createElement('div'); overlay.id='sender-disconnected-overlay';
        overlay.innerHTML=`
            <div class="sdo-card">
                <div class="sdo-icon"><i class="fas fa-plug-circle-xmark"></i></div>
                <div class="sdo-title">SENDER DISCONNECTED</div>
                <div class="sdo-body">The sender has left the session.<br>Any completed files can still be downloaded.</div>
                <div class="sdo-time"><i class="fas fa-clock"></i> Disconnected at ${now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</div>
                <div class="sdo-actions">
                    <button class="sdo-btn-dismiss" id="sdo-dismiss"><i class="fas fa-check"></i> Stay &amp; Download</button>
                    <button class="sdo-btn-reload"><i class="fas fa-rotate-right"></i> New Session</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.sdo-btn-reload').addEventListener('click',()=>location.reload());
        overlay.querySelector('#sdo-dismiss').addEventListener('click',()=>{
            overlay.style.transition='opacity 0.3s'; overlay.style.opacity='0';
            setTimeout(()=>overlay.remove(),310);
        });
    }

    // ── Tooltip ────────────────────────────────────────────────
    (function(){
        const tip=document.createElement('div'); tip.id='zer0-tooltip'; document.body.appendChild(tip);
        let current=null; const OX=14, OY=-38;
        const show=(el,x,y)=>{const n=el.getAttribute('data-fullname');if(!n)return;tip.textContent=n;tip.classList.add('visible');move(x,y);};
        const hide=()=>{tip.classList.remove('visible');current=null;};
        const move=(x,y)=>{const tw=tip.offsetWidth;let l=x+OX,t=y+OY;if(l+tw>window.innerWidth-8)l=x-tw-OX;if(t<8)t=y+18;tip.style.left=l+'px';tip.style.top=t+'px';};
        document.addEventListener('mouseover',e=>{const el=e.target.closest('[data-fullname]');if(el&&el!==current){current=el;show(el,e.clientX,e.clientY);}else if(!el&&current)hide();});
        document.addEventListener('mousemove',e=>{if(current)move(e.clientX,e.clientY);});
        document.addEventListener('mouseout',e=>{if(current&&!e.relatedTarget?.closest('[data-fullname]'))hide();});
    })();
})();
