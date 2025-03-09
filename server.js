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
app.use(express.json({ limit: '50mb' }));

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

// Helper functions for formatting
function formatPhoneNumber(jid) {
  if (!jid) return '';
  // Extract phone number from JID
  return jid.split('@')[0];
}

function formatTime(date) {
  if (!date) return '';
  // Format time as HH:MM
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      markOnlineOnConnect: true, // Mark as online when connected
      getMessage: async (key) => {
        return { conversation: 'Hello' }; // Default message for history sync
      }
    });
    
    // Initialize store for chats, contacts and messages
    sock.store = {
      chats: new Map(),
      contacts: {},
      messages: {}
    };
    
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
        
        // Fetch initial chats after connection
        try {
          console.log('Fetching initial chats for session:', sessionId);
          await sock.fetchChats();
          console.log('Initial chats fetched for session:', sessionId);
        } catch (error) {
          console.error('Error fetching initial chats:', error);
        }
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
        console.log('New message for session:', sessionId, 'count:', m.messages.length);
        
        // Store messages
        for (const msg of m.messages) {
          const jid = msg.key.remoteJid;
          
          // Skip status messages
          if (jid === 'status@broadcast') continue;
          
          // Initialize messages for this chat if not exists
          if (!sock.store.messages[jid]) {
            sock.store.messages[jid] = {
              messages: [],
              all: function() {
                return this.messages;
              }
            };
          }
          
          // Check if message already exists
          const exists = sock.store.messages[jid].messages.some(
            existingMsg => existingMsg.key.id === msg.key.id
          );
          
          if (!exists) {
            // Add message to store
            sock.store.messages[jid].messages.push(msg);
            
            // Update chat in store
            if (!sock.store.chats.has(jid)) {
              sock.store.chats.set(jid, {
                id: jid,
                conversationTimestamp: msg.messageTimestamp,
                unreadCount: msg.key.fromMe ? 0 : 1
              });
            } else {
              const chat = sock.store.chats.get(jid);
              chat.conversationTimestamp = msg.messageTimestamp;
              if (!msg.key.fromMe) {
                chat.unreadCount = (chat.unreadCount || 0) + 1;
              }
            }
          }
        }
        
        // Emit to client
        socket.emit('newMessage', { sessionId, messages: m.messages });
      }
    });
    
    // Handle chats
    sock.ev.on('chats.set', async (chats) => {
      console.log('Chats set for session:', sessionId, 'count:', chats.length);
      
      // Store chats
      for (const chat of chats) {
        sock.store.chats.set(chat.id, chat);
      }
    });
    
    sock.ev.on('chats.upsert', async (chats) => {
      console.log('Chats upsert for session:', sessionId, 'count:', chats.length);
      
      // Store chats
      for (const chat of chats) {
        sock.store.chats.set(chat.id, chat);
      }
    });
    
    // Handle contacts
    sock.ev.on('contacts.update', async (contacts) => {
      console.log('Contacts update for session:', sessionId, 'count:', contacts.length);
      
      // Store contacts
      for (const contact of contacts) {
        if (!sock.store.contacts[contact.id]) {
          sock.store.contacts[contact.id] = { id: contact.id };
        }
        
        Object.assign(sock.store.contacts[contact.id], contact);
      }
    });
    
    // Handle read messages
    sock.ev.on('messages.update', async (updates) => {
      console.log('Messages update for session:', sessionId, 'count:', updates.length);
      
      for (const update of updates) {
        const jid = update.key.remoteJid;
        
        // Skip status messages
        if (jid === 'status@broadcast') continue;
        
        // Check if this is a read status update
        if (update.update.status === 'READ') {
          // Update unread count for this chat
          if (sock.store.chats.has(jid)) {
            const chat = sock.store.chats.get(jid);
            chat.unreadCount = 0;
            
            // Emit chat update to client
            socket.emit('chatUpdate', { 
              sessionId, 
              chat: {
                jid: jid,
                unread: 0
              }
            });
          }
        }
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
  
  // Get chats for a session
  socket.on('getChats', async (sessionId, callback) => {
    console.log('Getting chats for session:', sessionId);
    
    try {
      const sock = clients[sessionId];
      
      if (!sock) {
        console.log('Client not found for session:', sessionId);
        callback({ success: false, error: 'Client not found' });
        return;
      }
      
      // Get chats from WhatsApp
      console.log('Fetching chats from WhatsApp...');
      
      try {
        // Try to fetch chats if we don't have any
        if (sock.store.chats.size === 0) {
          console.log('No chats in store, fetching from WhatsApp...');
          try {
            await sock.fetchChats();
            console.log('Chats fetched successfully');
          } catch (fetchError) {
            console.error('Error fetching chats:', fetchError);
          }
        }
        
        // Get all chats
        const chats = Array.from(sock.store.chats.values());
        console.log(`Found ${chats.length} chats`);
        
        // Format chats for client
        const formattedChats = await Promise.all(chats.map(async (chat) => {
          // Skip status broadcast
          if (chat.id === 'status@broadcast') return null;
          
          // Try to get contact name if available
          let name = '';
          try {
            if (chat.name) {
              name = chat.name;
            } else if (chat.id.endsWith('@s.whatsapp.net')) {
              // This is a private chat
              const contact = sock.store.contacts[chat.id];
              name = contact?.name || contact?.notify || formatPhoneNumber(chat.id);
            } else if (chat.id.endsWith('@g.us')) {
              // This is a group chat
              name = chat.subject || 'Group';
            }
          } catch (error) {
            console.error('Error getting contact name:', error);
            name = formatPhoneNumber(chat.id);
          }
          
          // Get last message if available
          let lastMessage = '';
          let time = '';
          
          try {
            if (sock.store.messages[chat.id]) {
              const messages = sock.store.messages[chat.id].all();
              if (messages && messages.length > 0) {
                const lastMsg = messages[messages.length - 1];
                lastMessage = lastMsg.message?.conversation || 
                             lastMsg.message?.extendedTextMessage?.text || 
                             'Media message';
                
                // Format time
                if (lastMsg.messageTimestamp) {
                  const date = new Date(lastMsg.messageTimestamp * 1000);
                  time = formatTime(date);
                }
              }
            }
          } catch (error) {
            console.error('Error getting last message:', error);
          }
          
          return {
            jid: chat.id,
            name: name || formatPhoneNumber(chat.id),
            lastMessage: lastMessage,
            time: time,
            unread: chat.unreadCount || 0
          };
        }));
        
        // Filter out null values (status broadcast)
        const filteredChats = formattedChats.filter(chat => chat !== null);
        
        // Sort chats by last message time (newest first)
        filteredChats.sort((a, b) => {
          if (!a.time) return 1;
          if (!b.time) return -1;
          return b.time.localeCompare(a.time);
        });
        
        callback({ success: true, chats: filteredChats });
      } catch (error) {
        console.error('Error getting chats:', error);
        callback({ success: false, error: error.message });
      }
    } catch (error) {
      console.error('Error in getChats:', error);
      callback({ success: false, error: error.message });
    }
  });
  
  // Get messages for a chat
  socket.on('getChatMessages', async (data, callback) => {
    const { sessionId, jid } = data;
    console.log('Getting messages for session:', sessionId, 'chat:', jid);
    
    try {
      const sock = clients[sessionId];
      
      if (!sock) {
        console.log('Client not found for session:', sessionId);
        callback({ success: false, error: 'Client not found' });
        return;
      }
      
      // Mark chat as read
      try {
        console.log('Marking chat as read:', jid);
        await sock.readMessages([{ remoteJid: jid, id: 'placeholder', participant: undefined }]);
        
        // Update unread count in store
        if (sock.store.chats.has(jid)) {
          const chat = sock.store.chats.get(jid);
          chat.unreadCount = 0;
        }
      } catch (readError) {
        console.error('Error marking chat as read:', readError);
      }
      
      // Get messages from WhatsApp
      console.log('Fetching messages from WhatsApp...');
      
      try {
        // Try to load messages from WhatsApp if we don't have any
        if (!sock.store.messages[jid] || sock.store.messages[jid].all().length === 0) {
          console.log('No messages in store, fetching from WhatsApp...');
          try {
            // Fetch messages from WhatsApp
            const messages = await sock.fetchMessagesFromWA(jid, 50);
            console.log(`Fetched ${messages.length} messages from WhatsApp`);
            
            // Store messages
            if (!sock.store.messages[jid]) {
              sock.store.messages[jid] = {
                messages: [],
                all: function() {
                  return this.messages;
                }
              };
            }
            
            sock.store.messages[jid].messages = messages;
          } catch (fetchError) {
            console.error('Error fetching messages from WhatsApp:', fetchError);
          }
        }
        
        // Check if we have messages for this chat
        if (!sock.store.messages[jid] || sock.store.messages[jid].all().length === 0) {
          console.log('No messages found for chat:', jid);
          callback({ success: true, messages: [] });
          return;
        }
        
        // Load messages from store
        const messages = sock.store.messages[jid].all();
        console.log(`Found ${messages.length} messages for chat:`, jid);
        
        // Format messages for client
        const formattedMessages = messages.map((msg) => {
          const fromMe = msg.key.fromMe;
          const text = msg.message?.conversation || 
                      msg.message?.extendedTextMessage?.text || 
                      'Media message';
          
          // Format time
          let time = '';
          if (msg.messageTimestamp) {
            const date = new Date(msg.messageTimestamp * 1000);
            time = formatTime(date);
          }
          
          return {
            id: msg.key.id,
            fromMe: fromMe,
            text: text,
            time: time,
            timestamp: msg.messageTimestamp
          };
        });
        
        // Sort messages by timestamp (oldest first)
        formattedMessages.sort((a, b) => {
          if (!a.timestamp) return -1;
          if (!b.timestamp) return 1;
          return a.timestamp - b.timestamp;
        });
        
        callback({ success: true, messages: formattedMessages });
      } catch (error) {
        console.error('Error getting messages:', error);
        callback({ success: false, error: error.message });
      }
    } catch (error) {
      console.error('Error in getChatMessages:', error);
      callback({ success: false, error: error.message });
    }
  });
  
  // Mark chat as read
  socket.on('markChatAsRead', async (data, callback) => {
    const { sessionId, jid } = data;
    console.log('Marking chat as read for session:', sessionId, 'chat:', jid);
    
    try {
      const sock = clients[sessionId];
      
      if (!sock) {
        console.log('Client not found for session:', sessionId);
        if (callback) callback({ success: false, error: 'Client not found' });
        return;
      }
      
      // Mark chat as read
      await sock.readMessages([{ remoteJid: jid, id: 'placeholder', participant: undefined }]);
      
      // Update unread count in store
      if (sock.store.chats.has(jid)) {
        const chat = sock.store.chats.get(jid);
        chat.unreadCount = 0;
      }
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error marking chat as read:', error);
      if (callback) callback({ success: false, error: error.message });
    }
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

// Logout endpoint for HTTP requests
app.post('/logout', (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  console.log('HTTP logout request for session:', sessionId);
  
  if (clients[sessionId]) {
    try {
      // Logout asynchronously but don't wait for it to complete
      clients[sessionId].logout()
        .then(() => {
          console.log('HTTP logout successful for session:', sessionId);
          delete clients[sessionId];
          sessionStatus[sessionId] = 'logged_out';
          
          // Delete session folder
          const sessionFolder = path.join(sessionsDir, sessionId);
          if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
          }
        })
        .catch(error => {
          console.error('HTTP logout error for session:', sessionId, error);
          sessionStatus[sessionId] = 'error';
        });
      
      // Respond immediately
      res.json({ success: true, message: 'Logout initiated' });
    } catch (error) {
      console.error('Error initiating HTTP logout for session:', sessionId, error);
      res.status(500).json({ error: error.message });
    }
  } else {
    console.log('Session not found for HTTP logout:', sessionId);
    res.status(404).json({ error: 'Session not found' });
  }
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
