# Zer0send - Secure P2P File Sharing

A secure peer-to-peer file sharing application using WebRTC and Socket.io. Share files directly between browsers without uploading to any server.

## Features

- 🔒 **Secure**: Files are transferred directly between peers using WebRTC
- 🚀 **Fast**: No server upload/download - direct peer-to-peer transfer
- 🎯 **Simple**: Easy-to-use interface with room-based sharing
- 📁 **Any File Type**: Share any type of file
- 💻 **Real-time**: See transfer progress in real-time

## How It Works

1. **Sender** creates a room and gets a unique Room ID
2. **Receiver** joins using the Room ID
3. **WebRTC** establishes a direct peer-to-peer connection
4. Files are transferred directly between browsers
5. **Socket.io** is only used for initial signaling (establishing connection)

## Installation

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn

### Steps

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser:
- **Sender**: http://localhost:3000
- **Receiver**: http://localhost:3000/receiver

## Usage

### Sending Files

1. Open http://localhost:3000 in your browser
2. Click "Create Room" button
3. Share the generated Room ID with the receiver
4. Wait for receiver to connect
5. Select a file to share

### Receiving Files

1. Open http://localhost:3000/receiver in your browser
2. Enter the Room ID from the sender
3. Click "Connect"
4. File will automatically download when sender shares it

## Technology Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Node.js, Express
- **Real-time Communication**: Socket.io
- **P2P Transfer**: WebRTC Data Channels
- **File Download**: download.js library

## Architecture

```
┌─────────┐                                ┌──────────┐
│ Sender  │◄─────── Socket.io ────────────►│ Receiver │
└────┬────┘         (Signaling)            └────┬─────┘
     │                                           │
     └──────────── WebRTC P2P ──────────────────┘
              (Direct File Transfer)
```

## File Structure

```
zer0send/
├── server.js           # Node.js server with Socket.io
├── index.html          # Sender page
├── receiver.html       # Receiver page
├── code.js            # Sender JavaScript
├── receiver.js        # Receiver JavaScript
├── style.css          # Styling
├── package.json       # Dependencies
└── README.md          # Documentation
```

## Development

Run with auto-reload:
```bash
npm run dev
```

## Security Notes

- Files are transferred directly between peers (P2P)
- The server only facilitates the initial connection (signaling)
- Room IDs are randomly generated and temporary
- No files are stored on the server
- Connection uses STUN server for NAT traversal

## Limitations

- Both users must be online simultaneously
- Large files may take time depending on connection speed
- Some corporate firewalls may block WebRTC
- TURN server not configured (may not work on restrictive networks)

## Future Enhancements

- [ ] Add TURN server support for restrictive networks
- [ ] Multiple file selection
- [ ] Drag and drop interface
- [ ] Transfer progress with speed indicator
- [ ] Encryption for sensitive files
- [ ] Chat functionality
- [ ] File preview
- [ ] Mobile responsive design improvements

## License

MIT

## Contributing

Pull requests are welcome! For major changes, please open an issue first.

## Troubleshooting

**Connection fails:**
- Check if both users are on the same network or have proper internet
- Try disabling firewall temporarily
- Check browser console for errors

**File not downloading:**
- Ensure receiver browser allows downloads
- Check browser compatibility (Chrome, Firefox, Edge recommended)
- Clear browser cache and try again

**Room ID not working:**
- Make sure receiver enters the exact Room ID
- IDs are case-sensitive
- Create a new room if issues persist
