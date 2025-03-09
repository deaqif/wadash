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
const sessionStatus = {}; // Track session status

// Create sessions directory if it doesn't exist
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Function to check if session exists
function sessionExists(sessionId) {
  const sessionFolder = path.join(sessionsDir, sessionId);
  return fs.existsSync(sessionFolder) && fs.readdirSync(sessionFolder).length > 0;
}

// Function to create WhatsApp client
async function createWhatsAppClient(sessionId, socket) {
  console.log('Creating WhatsApp client for session:', sessionId);
  
  try {
    const sessionFolder = path.join(sessionsDir, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    console.log('Auth state loaded for session:', sessionId);
    
    // Create WhatsApp client with more robust options
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      connectTimeoutMs: 60000, // Increase timeout to 60 seconds
      keepAliveIntervalMs: 25000, // Keep alive every 25 seconds
      retryRequestDelayMs: 1000, // Retry delay
      defaultQueryTimeoutMs: 60000, // Query timeout
      emitOwnEvents: true, // Emit own events
      browser: ['WhatsApp Dashboard', 'Chrome', '10.0'], // Browser info
      markOnlineOnConnect: true // Mark as online when connected
    });
    
    clients[sessionId] = sock;
    sessionStatus[sessionId] = 'connecting';
    
    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      console.log('Connection update for session:', sessionId, JSON.stringify(update));
      
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('QR Code generated for session:', sessionId);
        sessionStatus[sessionId] = 'qr_generated';
        // Send QR code to client
        socket.emit('qrCode', { sessionId, qrCode: qr });
      }
      
      if (connection === 'open') {
        console.log('Connected with session:', sessionId);
        sessionStatus[sessionId] = 'connected';
        socket.emit('ready', { sessionId });
        
        // Store connection time
        const connectionInfo = {
          connectedAt: new Date().toISOString(),
          phoneNumber: sock.user?.id?.split(':')[0]
        };
        
        fs.writeFileSync(
          path.join(sessionFolder, 'connection_info.json'),
          JSON.stringify(connectionInfo, null, 2)
        );
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('Connection closed for session:', sessionId, 
                    'Status code:', statusCode,
                    'Reason:', lastDisconnect?.error?.message || 'Unknown', 
                    'Reconnecting:', shouldReconnect);
        
        if (shouldReconnect) {
          // Reconnect if not logged out
          sessionStatus[sessionId] = 'reconnecting';
          socket.emit('disconnected', { 
            sessionId, 
            reason: lastDisconnect?.error?.message || 'connection closed', 
            reconnecting: true 
          });
          
          // Attempt to reconnect after a delay
          setTimeout(() => {
            if (sessionStatus[sessionId] === 'reconnecting') {
              console.log('Attempting to reconnect session:', sessionId);
              delete clients[sessionId];
              createWhatsAppClient(sessionId, socket);
            }
          }, 5000);
        } else {
          // Logged out
          sessionStatus[sessionId] = 'logged_out';
          delete clients[sessionId];
          socket.emit('loggedOut', { sessionId });
        }
      }
    });
    
    // Handle messages
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        console.log('New message for session:', sessionId);
        socket.emit('newMessage', { sessionId, messages: m.messages });
      }
    });
    
    // Handle credentials update
    sock.ev.on('creds.update', async () => {
      console.log('Credentials updated for session:', sessionId);
      await saveCreds();
    });
    
    return sock;
  } catch (error) {
    console.error('Error creating WhatsApp client for session:', sessionId, error);
    sessionStatus[sessionId] = 'error';
    socket.emit('error', { sessionId, error: error.message });
    return null;
  }
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Generate QR code for new WhatsApp session
  socket.on('generateQR', async (sessionId, callback) => {
    console.log('Generating QR for session:', sessionId);
    
    try {
      // Check if client already exists
      if (clients[sessionId]) {
        console.log('Client already exists for session:', sessionId);
        callback({ success: true, status: sessionStatus[sessionId] });
        return;
      }
      
      // Create WhatsApp client
      await createWhatsAppClient(sessionId, socket);
      callback({ success: true });
    } catch (error) {
      console.error('Error generating QR for session:', sessionId, error);
      callback({ error: error.message });
    }
  });
  
  // Reconnect existing session
  socket.on('reconnectSession', async (sessionId, callback) => {
    console.log('Reconnecting session:', sessionId);
    
    try {
      // Check if session exists
      if (!sessionExists(sessionId)) {
        console.log('Session does not exist:', sessionId);
        callback({ error: 'Session does not exist' });
        return;
      }
      
      // Delete existing client if any
      if (clients[sessionId]) {
        delete clients[sessionId];
      }
      
      // Create new WhatsApp client
      await createWhatsAppClient(sessionId, socket);
      callback({ success: true });
    } catch (error) {
      console.error('Error reconnecting session:', sessionId, error);
      callback({ error: error.message });
    }
  });
  
  // Check session status
  socket.on('checkSession', (sessionId, callback) => {
    console.log('Checking session status:', sessionId);
    
    const status = sessionStatus[sessionId] || 'unknown';
    const isConnected = status === 'connected';
    
    callback({
      success: true,
      status,
      connected: isConnected,
      client: isConnected ? {
        exists: true,
        id: clients[sessionId]?.user?.id
      } : null
    });
  });
  
  // Logout from WhatsApp
  socket.on('logout', async (sessionId, callback) => {
    console.log('Logging out session:', sessionId);
    
    if (clients[sessionId]) {
      try {
        sessionStatus[sessionId] = 'logging_out';
        await clients[sessionId].logout();
        delete clients[sessionId];
        
        // Delete session folder
        const sessionFolder = path.join(sessionsDir, sessionId);
        if (fs.existsSync(sessionFolder)) {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
        }
        
        console.log('Session logged out and folder deleted:', sessionId);
        sessionStatus[sessionId] = 'logged_out';
        socket.emit('logoutSuccess', { sessionId });
        
        if (callback) callback({ success: true });
      } catch (error) {
        console.error('Logout error for session:', sessionId, error);
        sessionStatus[sessionId] = 'error';
        socket.emit('logoutError', { sessionId, error: error.message });
        
        if (callback) callback({ error: error.message });
      }
    } else {
      console.log('Session not found for logout:', sessionId);
      socket.emit('logoutError', { sessionId, error: 'Session not found' });
      
      if (callback) callback({ error: 'Session not found' });
    }
  });
  
  // Send message
  socket.on('sendMessage', async (data, callback) => {
    const { sessionId, to, message } = data;
    console.log('Sending message for session:', sessionId, 'to:', to);
    
    if (!clients[sessionId]) {
      console.log('Client not found for session:', sessionId);
      if (callback) callback({ error: 'Client not found' });
      return;
    }
    
    try {
      const result = await clients[sessionId].sendMessage(to, { text: message });
      console.log('Message sent for session:', sessionId, 'result:', result);
      if (callback) callback({ success: true, result });
    } catch (error) {
      console.error('Error sending message for session:', sessionId, error);
      if (callback) callback({ error: error.message });
    }
  });
  
  // Disconnect event
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Note: We don't delete the WhatsApp clients here to keep them running
  });
});

// API endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    sessions: Object.keys(clients).length
  });
});

// Check session status endpoint
app.post('/check-status', (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  const status = sessionStatus[sessionId] || 'unknown';
  const isConnected = status === 'connected';
  
  res.json({
    success: true,
    sessionId,
    status,
    connected: isConnected,
    client: isConnected ? {
      exists: true,
      id: clients[sessionId]?.user?.id
    } : null
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Sessions directory: ${sessionsDir}`);
});

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  
  // Logout all clients
  for (const sessionId in clients) {
    try {
      console.log('Logging out session:', sessionId);
      await clients[sessionId].logout();
    } catch (error) {
      console.error('Error logging out session:', sessionId, error);
    }
  }
  
  process.exit(0);
});
