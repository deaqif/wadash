const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active WhatsApp clients
const clients = {};
const sessionsDir = path.join(__dirname, 'sessions');

// Create sessions directory if it doesn't exist
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Generate QR code for new WhatsApp session
  socket.on('generateQR', async (sessionId) => {
    console.log('Generating QR for session:', sessionId);
    
    const sessionFolder = path.join(sessionsDir, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true
    });
    
    clients[sessionId] = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        // Send QR code to client
        socket.emit('qrCode', { sessionId, qrCode: qr });
      }
      
      if (connection === 'open') {
        console.log('Connected with ' + sessionId);
        socket.emit('ready', { sessionId });
      }
      
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
        
        if (shouldReconnect) {
          // Reconnect if not logged out
          delete clients[sessionId];
          socket.emit('disconnected', { sessionId, reason: 'connection closed', reconnecting: true });
        } else {
          // Logged out
          delete clients[sessionId];
          socket.emit('loggedOut', { sessionId });
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
  });

  // Logout from WhatsApp
  socket.on('logout', async (sessionId) => {
    console.log('Logging out session:', sessionId);
    
    if (clients[sessionId]) {
      try {
        await clients[sessionId].logout();
        delete clients[sessionId];
        
        // Delete session folder
        const sessionFolder = path.join(sessionsDir, sessionId);
        if (fs.existsSync(sessionFolder)) {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
        }
        
        socket.emit('logoutSuccess', { sessionId });
      } catch (error) {
        console.error('Logout error:', error);
        socket.emit('logoutError', { sessionId, error: error.message });
      }
    } else {
      socket.emit('logoutError', { sessionId, error: 'Session not found' });
    }
  });

  // Disconnect event
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp API Server is running');
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
