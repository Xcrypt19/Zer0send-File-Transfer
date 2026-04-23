const express = require('express');
const app = express();
const http = require('http').createServer(app);

// Suppress the X-Powered-By: Express header — leaks framework info to attackers.
app.disable('x-powered-by');

// Lock signalling to the production origin.
// Set ALLOWED_ORIGIN env var to override for local dev (e.g. http://localhost:3000).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://zer0send.onrender.com';

const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] }
});
const path = require('path');
const PORT = process.env.PORT || 3000;

// ── Per-socket rate limiter ────────────────────────────────────────────────
// No external package needed — a simple fixed-window counter per socket ID.
// makeRateLimiter(max, windowMs) returns an allow(socketId) function.
// Returns true when the event should be processed, false when the socket has
// exceeded its quota and the event should be silently dropped.
//
// Limits are intentionally generous — they stop abuse, not real usage:
//   sender-join   5 / min  — spamming room creation exhausts the senders map
//   receiver-join 10 / min — tight-loop joining can exhaust roomReceivers
//   offer/answer  20 / min — ICE restart storms during reconnection attempts
//   candidate     60 / min — normal ICE trickle is 5-15 candidates per session
//   kick          20 / min — prevent kick-spam against a room's receivers
//
function makeRateLimiter(maxCalls, windowMs) {
    const windows = new Map(); // socketId -> { count, resetAt }

    // Prune stale entries every 5 minutes so the Map doesn't grow forever
    // on servers with high connection churn.
    setInterval(() => {
        const now = Date.now();
        for (const [id, w] of windows) {
            if (now >= w.resetAt) windows.delete(id);
        }
    }, 5 * 60_000);

    return function allow(socketId) {
        const now = Date.now();
        const w   = windows.get(socketId);
        if (!w || now >= w.resetAt) {
            windows.set(socketId, { count: 1, resetAt: now + windowMs });
            return true;
        }
        if (w.count >= maxCalls) return false;
        w.count++;
        return true;
    };
}

const rl = {
    senderJoin:   makeRateLimiter(5,  60_000),
    receiverJoin: makeRateLimiter(10, 60_000),
    offer:        makeRateLimiter(20, 60_000),
    answer:       makeRateLimiter(20, 60_000),
    candidate:    makeRateLimiter(60, 60_000),
    kick:         makeRateLimiter(20, 60_000),
};

// ── Security headers ───────────────────────────────────────────────────────
// IMPORTANT: this middleware must be registered BEFORE express.static so that
// every response — including static files — carries the full header set.
// Placing it after express.static means static responses bypass all headers,
// which is what caused the CSP, HSTS, X-Frame-Options, and X-Content-Type-Options
// findings in the ZAP audit.
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
    //
    // frame-ancestors and form-action do NOT fall back to default-src per the
    // CSP spec, so they must always be listed explicitly.
    // ─────────────────────────────────────────────────────────────────────
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://socket.io",
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

// ── Static files ───────────────────────────────────────────────────────────
// etag: false + lastModified: false — the default ETag format embeds the
// file's mtime as a hex value (e.g. W/"8673-19db3b02230"), which leaks
// server-side filesystem timestamps. Disabling both removes that disclosure.
// Browsers will re-validate on each deployment, which is correct behaviour
// for an app served via Render where files change only on deploy.
app.use(express.static(__dirname, { etag: false, lastModified: false }));

// ── robots.txt ─────────────────────────────────────────────────────────────
// Explicitly handled so it returns 200 with a proper CSP rather than a 404.
// Disallow session pages from indexing — they're useless without a live room.
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nDisallow: /sender\nDisallow: /receiver\n');
});

app.get('/', (req, res) => {
    const homeFile = path.join(__dirname, 'home.html');
    const fs = require('fs');
    if (fs.existsSync(homeFile)) res.sendFile(homeFile);
    else res.redirect('/sender');
});

// Cache-Control: no-store on session pages so browsers never cache sender/
// receiver HTML. These pages hold live WebRTC state; a stale cached copy
// would connect to a dead room. ZAP also flagged public caching of these pages.
app.get('/sender',   (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'sender.html'));
});
app.get('/receiver', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'receiver.html'));
});

// ── Room / receiver caps ───────────────────────────────────────────────────
// Prevents unbounded memory growth from attacker-controlled socket churn.
const MAX_ROOMS              = 500;   // global concurrent room limit
const MAX_RECEIVERS_PER_ROOM = 20;    // per-room receiver limit

// uid  ->  sender socket.id
const senders = {};

// uid  ->  Map< receiverSocketId, { alias, joinedAt } >
const roomReceivers = {};

// receiverSocketId  ->  uid  (reverse lookup)
const receiverRooms = {};

// socketId  ->  uid  (covers BOTH senders and receivers for signalling auth)
// Used to verify that offer/answer/candidate events come from a socket that
// actually belongs to the room it claims to be addressing.
const socketRooms = {};

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

    // Sender joins ------------------------------------------------
    socket.on('sender-join', (data) => {
        if (!rl.senderJoin(socket.id)) {
            socket.emit('error', { message: 'Too many room creations — please slow down.' });
            return;
        }
        if (!data || typeof data.uid !== 'string' || !/^\d{3}-\d{3}-\d{3}$/.test(data.uid)) {
            socket.emit('error', { message: 'Invalid room ID format.' });
            return;
        }
        if (Object.keys(senders).length >= MAX_ROOMS) {
            socket.emit('error', { message: 'Server is at capacity — please try again later.' });
            return;
        }
        // Prevent UID hijacking: reject only if another *live* socket already owns this room.
        // We gate on io.sockets.sockets.get() rather than a bare senders[uid] check to
        // handle the race where the old sender socket disconnected but the disconnect event
        // hasn't fired yet — in that case the entry is stale and we allow the rejoin.
        // This also means a legitimate sender whose socket auto-reconnected (new socket.id,
        // same uid) can reclaim their own room without being falsely blocked.
        if (senders[data.uid] && io.sockets.sockets.get(senders[data.uid])) {
            socket.emit('error', { message: 'Room already exists — choose a different ID.' });
            return;
        }
        senders[data.uid] = socket.id;
        socketRooms[socket.id] = data.uid;
        roomReceivers[data.uid] = roomReceivers[data.uid] || new Map();
        socket.join(data.uid);
    });

    // Receiver joins ----------------------------------------------
    socket.on('receiver-join', (data) => {
        if (!rl.receiverJoin(socket.id)) {
            socket.emit('error', { message: 'Too many join attempts — please slow down.' });
            return;
        }
        if (!data || typeof data.uid !== 'string' || !/^\d{3}-\d{3}-\d{3}$/.test(data.uid)) {
            socket.emit('error', { message: 'Invalid room ID format.' });
            return;
        }
        const senderSocketId = senders[data.uid];
        if (!senderSocketId) {
            socket.emit('error', { message: 'Invalid room ID — no sender found.' });
            return;
        }
        if (!roomReceivers[data.uid]) roomReceivers[data.uid] = new Map();
        if (roomReceivers[data.uid].size >= MAX_RECEIVERS_PER_ROOM) {
            socket.emit('error', { message: 'Room is full — maximum receivers reached.' });
            return;
        }
        // Clamp alias to 32 chars so a huge string can't bloat the receiver list payload
        const alias = (typeof data.alias === 'string' ? data.alias.slice(0, 32).trim() : '') || ('User-' + socket.id.slice(-4).toUpperCase());
        roomReceivers[data.uid].set(socket.id, { alias, joinedAt: Date.now() });
        receiverRooms[socket.id] = data.uid;
        socketRooms[socket.id]   = data.uid;
        socket.join(data.uid);

        // Tell the receiver who the sender is
        socket.emit('init', senderSocketId);
        // Tell the sender a new receiver has arrived (id = receiver socket)
        io.to(senderSocketId).emit('init', socket.id);
        // Push updated list to sender
        broadcastReceiverList(data.uid);
    });

    // WebRTC signalling -------------------------------------------
    // data.uid here is the TARGET socket ID (not a room UID). The server routes
    // each message directly to that peer with socket.to(socketId).
    //
    // Security requirement: both the emitting socket AND the target socket must
    // be registered in the same room. Without this check, any socket could inject
    // offers/answers/candidates into a peer connection in a completely different room.
    //
    // We look up both sides in socketRooms and require them to match.
    // If either side has no entry the message is dropped — that covers the case
    // of a socket that never legitimately joined any room.
    socket.on('offer', (data) => {
        if (!rl.offer(socket.id) || !data || typeof data.uid !== 'string') return;
        const myRoom     = socketRooms[socket.id];
        const targetRoom = socketRooms[data.uid];
        if (!myRoom || !targetRoom || myRoom !== targetRoom) return;
        socket.to(data.uid).emit('offer', { offer: data.offer, uid: socket.id });
    });
    socket.on('answer', (data) => {
        if (!rl.answer(socket.id) || !data || typeof data.uid !== 'string') return;
        const myRoom     = socketRooms[socket.id];
        const targetRoom = socketRooms[data.uid];
        if (!myRoom || !targetRoom || myRoom !== targetRoom) return;
        socket.to(data.uid).emit('answer', { answer: data.answer, uid: socket.id });
    });
    socket.on('candidate', (data) => {
        if (!rl.candidate(socket.id) || !data || typeof data.uid !== 'string') return;
        const myRoom     = socketRooms[socket.id];
        const targetRoom = socketRooms[data.uid];
        if (!myRoom || !targetRoom || myRoom !== targetRoom) return;
        socket.to(data.uid).emit('candidate', { candidate: data.candidate, uid: socket.id });
    });

    // Sender kicks a receiver ------------------------------------
    socket.on('kick-receiver', (data) => {
        if (!rl.kick(socket.id) || !data || typeof data.uid !== 'string') return;
        const { receiverSocketId, uid } = data;
        if (senders[uid] !== socket.id) return;   // only the room owner can kick
        // Verify the target socket is actually in this room — prevents a sender
        // from emitting 'kicked' to arbitrary sockets in unrelated rooms.
        if (!roomReceivers[uid] || !roomReceivers[uid].has(receiverSocketId)) return;
        const target = io.sockets.sockets.get(receiverSocketId);
        if (target) target.emit('kicked', { reason: 'You have been removed by the sender.' });
        roomReceivers[uid].delete(receiverSocketId);
        delete receiverRooms[receiverSocketId];
        delete socketRooms[receiverSocketId];
        broadcastReceiverList(uid);
    });

    // Disconnect --------------------------------------------------
    socket.on('disconnect', () => {
        // Was it a sender?
        for (const uid in senders) {
            if (senders[uid] === socket.id) {
                delete senders[uid];
                delete socketRooms[socket.id];
                if (roomReceivers[uid]) {
                    roomReceivers[uid].forEach((_info, rid) => {
                        const rs = io.sockets.sockets.get(rid);
                        if (rs) rs.emit('sender-disconnected');
                        delete receiverRooms[rid];
                        delete socketRooms[rid];
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
            delete socketRooms[socket.id];
        }
    });
});

http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Sender:   http://localhost:${PORT}/sender`);
    console.log(`Receiver: http://localhost:${PORT}/receiver`);
});
