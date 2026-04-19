const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
const path = require('path');
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// ── Security headers ───────────────────────────────────────────────────────
app.use((req, res, next) => {
    // Blocks clickjacking — no page may embed this site in an <iframe>.
    res.setHeader('X-Frame-Options', 'DENY');

    // Prevents MIME-type sniffing; browser must honour the declared Content-Type.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Tells browsers to only reach this site over HTTPS for the next year.
    // Render.com terminates TLS before this process, so this header is always safe to send.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    // Stops the Referer header leaking the full URL to third-party requests.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Disables browser features the app never uses.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // Content-Security-Policy
    // ─────────────────────────────────────────────────────────────────────
    // 'unsafe-inline' is kept for script-src and style-src because the HTML
    // files use inline <script> and <style> blocks. Removing it would require
    // adding per-block nonces — a worthwhile follow-up, but out of scope here.
    //
    // connect-src covers:
    //   • wss: / ws:  — Socket.io WebSocket upgrades
    // WebRTC STUN traffic is handled by the browser's ICE agent, not fetch/XHR,
    // so STUN server URLs don't need to appear in connect-src.
    //
    // worker-src blob: covers JSZip's internal web-worker on the receiver page.
    // ─────────────────────────────────────────────────────────────────────
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self' wss: ws:",
        "worker-src blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; '));

    next();
});

app.get('/', (req, res) => {
    const homeFile = path.join(__dirname, 'home.html');
    const fs = require('fs');
    if (fs.existsSync(homeFile)) res.sendFile(homeFile);
    else res.redirect('/sender');
});
app.get('/sender', (req, res) => res.sendFile(path.join(__dirname, 'sender.html')));
app.get('/receiver', (req, res) => res.sendFile(path.join(__dirname, 'receiver.html')));

// uid  ->  sender socket.id
const senders = {};

// uid  ->  Map< receiverSocketId, { alias, joinedAt } >
const roomReceivers = {};

// receiverSocketId  ->  uid  (reverse lookup)
const receiverRooms = {};

function broadcastReceiverList(uid) {
    const senderSocketId = senders[uid];
    if (!senderSocketId) return;
    const map  = roomReceivers[uid] || new Map();
    const list = Array.from(map.entries()).map(([sid, info]) => ({
        socketId: sid,
        alias:    info.alias,
        joinedAt: info.joinedAt,
    }));
    io.to(senderSocketId).emit('receiver-list', { count: list.length, receivers: list });
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Sender joins ------------------------------------------------
    socket.on('sender-join', (data) => {
        console.log('Sender joined room:', data.uid);
        senders[data.uid] = socket.id;
        roomReceivers[data.uid] = roomReceivers[data.uid] || new Map();
        socket.join(data.uid);
    });

    // Receiver joins ----------------------------------------------
    socket.on('receiver-join', (data) => {
        console.log('Receiver joining room:', data.uid);
        const senderSocketId = senders[data.uid];
        if (!senderSocketId) {
            socket.emit('error', { message: 'Invalid room ID — no sender found.' });
            return;
        }
        if (!roomReceivers[data.uid]) roomReceivers[data.uid] = new Map();
        const alias = data.alias || ('User-' + socket.id.slice(-4).toUpperCase());
        roomReceivers[data.uid].set(socket.id, { alias, joinedAt: Date.now() });
        receiverRooms[socket.id] = data.uid;
        socket.join(data.uid);

        // Tell the receiver who the sender is
        socket.emit('init', senderSocketId);
        // Tell the sender a new receiver has arrived (id = receiver socket)
        io.to(senderSocketId).emit('init', socket.id);
        // Push updated list to sender
        broadcastReceiverList(data.uid);
    });

    // WebRTC signalling -------------------------------------------
    socket.on('offer', (data) => {
        socket.to(data.uid).emit('offer', { offer: data.offer, uid: socket.id });
    });
    socket.on('answer', (data) => {
        socket.to(data.uid).emit('answer', { answer: data.answer, uid: socket.id });
    });
    socket.on('candidate', (data) => {
        socket.to(data.uid).emit('candidate', { candidate: data.candidate, uid: socket.id });
    });

    // Sender kicks a receiver ------------------------------------
    socket.on('kick-receiver', (data) => {
        const { receiverSocketId, uid } = data;
        if (senders[uid] !== socket.id) return;   // only the room owner can kick
        const target = io.sockets.sockets.get(receiverSocketId);
        if (target) target.emit('kicked', { reason: 'You have been removed by the sender.' });
        if (roomReceivers[uid]) roomReceivers[uid].delete(receiverSocketId);
        delete receiverRooms[receiverSocketId];
        broadcastReceiverList(uid);
    });

    // Disconnect --------------------------------------------------
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);

        // Was it a sender?
        for (const uid in senders) {
            if (senders[uid] === socket.id) {
                delete senders[uid];
                if (roomReceivers[uid]) {
                    roomReceivers[uid].forEach((_info, rid) => {
                        const rs = io.sockets.sockets.get(rid);
                        if (rs) rs.emit('sender-disconnected');
                        delete receiverRooms[rid];
                    });
                    delete roomReceivers[uid];
                }
                break;
            }
        }

        // Was it a receiver?
        if (receiverRooms[socket.id]) {
            const uid = receiverRooms[socket.id];
            if (roomReceivers[uid]) {
                roomReceivers[uid].delete(socket.id);
                if (senders[uid]) {
                    io.to(senders[uid]).emit('receiver-left', { socketId: socket.id });
                    broadcastReceiverList(uid);
                }
            }
            delete receiverRooms[socket.id];
        }
    });
});

http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Sender:   http://localhost:${PORT}/sender`);
    console.log(`Receiver: http://localhost:${PORT}/receiver`);
});
