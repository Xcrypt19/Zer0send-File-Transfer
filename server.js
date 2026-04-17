const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

app.get('/sender', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/receiver', (req, res) => {
    res.sendFile(path.join(__dirname, 'receiver.html'));
});

// Store active connections
let senders = {};
let receivers = {};

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Sender joins
    socket.on('sender-join', (data) => {
        console.log('Sender joined with ID:', data.uid);
        senders[data.uid] = socket.id;
        socket.join(data.uid);
    });

    // Receiver joins
    socket.on('receiver-join', (data) => {
        console.log('Receiver joined room:', data.uid);
        
        if(senders[data.uid]){
            receivers[socket.id] = data.uid;
            socket.join(data.uid);
            
            // Notify sender that receiver has joined
            socket.to(senders[data.uid]).emit('init', socket.id);
            // Notify receiver to initialize
            socket.emit('init', senders[data.uid]);
        } else {
            socket.emit('error', { message: 'Invalid room ID' });
        }
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        console.log('Offer received');
        socket.to(data.uid).emit('offer', {
            offer: data.offer,
            uid: socket.id
        });
    });

    socket.on('answer', (data) => {
        console.log('Answer received');
        socket.to(data.uid).emit('answer', {
            answer: data.answer,
            uid: socket.id
        });
    });

    socket.on('candidate', (data) => {
        console.log('ICE candidate received');
        socket.to(data.uid).emit('candidate', {
            candidate: data.candidate,
            uid: socket.id
        });
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        
        // Clean up sender
        for(let uid in senders){
            if(senders[uid] === socket.id){
                delete senders[uid];
                break;
            }
        }
        
        // Clean up receiver
        if(receivers[socket.id]){
            delete receivers[socket.id];
        }
    });
});

http.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Home page:     http://localhost:${PORT}/`);
    console.log(`Sender page:   http://localhost:${PORT}/sender`);
    console.log(`Receiver page: http://localhost:${PORT}/receiver`);
});
