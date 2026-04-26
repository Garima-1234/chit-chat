const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 8001;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const initialStore = {
      users: {},
      rooms: {},
      personalChats: {}
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(initialStore, null, 2), 'utf8');
  }
}

function loadStore() {
  ensureStore();

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('Failed to read store.json, recreating a clean store.', error);
    const fallbackStore = {
      users: {},
      rooms: {},
      personalChats: {}
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(fallbackStore, null, 2), 'utf8');
    return fallbackStore;
  }
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .toUpperCase();
}

function createMessage({ senderName, senderPhone, text, system = false }) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderName,
    senderPhone,
    text,
    system,
    reactions: [],
    sentAt: new Date().toISOString()
  };
}

function formatConversationKey(type, id) {
  return `${type}:${id}`;
}

function getPrivateChatId(phoneA, phoneB) {
  return [phoneA, phoneB].sort().join('__');
}

function getConversationRoom(key) {
  return `conversation:${key}`;
}

function getRoomConversation(roomCode) {
  if (!store.rooms[roomCode]) {
    store.rooms[roomCode] = {
      id: roomCode,
      name: roomCode,
      createdAt: new Date().toISOString(),
      messages: []
    };
    saveStore();
  }

  return store.rooms[roomCode];
}

function getPersonalConversation(phoneA, phoneB) {
  const chatId = getPrivateChatId(phoneA, phoneB);

  if (!store.personalChats[chatId]) {
    store.personalChats[chatId] = {
      id: chatId,
      participants: [phoneA, phoneB].sort(),
      createdAt: new Date().toISOString(),
      messages: []
    };
    saveStore();
  }

  return store.personalChats[chatId];
}

function updateStoredUser(name, phone) {
  store.users[phone] = {
    phone,
    name,
    lastSeenAt: new Date().toISOString()
  };
  saveStore();
}

function getStoredUser(phone) {
  return store.users[phone] || null;
}

function getConversationPayload(type, entity, viewerPhone) {
  if (type === 'room') {
    return {
      key: formatConversationKey('room', entity.id),
      type: 'room',
      id: entity.id,
      title: entity.name,
      subtitle: `Room code: ${entity.id}`,
      history: entity.messages
    };
  }

  const otherPhone = entity.participants.find(phone => phone !== viewerPhone) || viewerPhone;
  const otherUser = store.users[otherPhone];

  return {
    key: formatConversationKey('personal', entity.id),
    type: 'personal',
    id: entity.id,
    title: otherUser ? otherUser.name : `Chat with ${otherPhone}`,
    subtitle: `Phone: ${otherPhone}`,
    targetPhone: otherPhone,
    history: entity.messages
  };
}

function getPersonalChatList(phone) {
  return Object.values(store.personalChats)
    .filter(chat => chat.participants.includes(phone))
    .map(chat => {
      const otherPhone = chat.participants.find(participant => participant !== phone) || phone;
      const otherUser = store.users[otherPhone];
      const lastMessage = chat.messages[chat.messages.length - 1] || null;

      return {
        key: formatConversationKey('personal', chat.id),
        chatId: chat.id,
        targetPhone: otherPhone,
        title: otherUser ? otherUser.name : `Chat with ${otherPhone}`,
        subtitle: `Phone: ${otherPhone}`,
        preview: lastMessage ? lastMessage.text : 'No messages yet',
        updatedAt: lastMessage ? lastMessage.sentAt : chat.createdAt
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function isPhoneInPersonalChat(chat, phone) {
  return chat.participants.includes(phone);
}

function addSocketForPhone(phone, socketId) {
  if (!phoneToSockets.has(phone)) {
    phoneToSockets.set(phone, new Set());
  }

  phoneToSockets.get(phone).add(socketId);
}

function removeSocketForPhone(phone, socketId) {
  if (!phoneToSockets.has(phone)) {
    return;
  }

  const sockets = phoneToSockets.get(phone);
  sockets.delete(socketId);

  if (sockets.size === 0) {
    phoneToSockets.delete(phone);
  }
}

function leaveActiveConversation(socket) {
  const session = sessions.get(socket.id);

  if (!session || !session.activeConversationKey) {
    return;
  }

  socket.leave(getConversationRoom(session.activeConversationKey));
  session.activeConversationKey = null;
}

function sendConversationError(callback, message) {
  if (typeof callback === 'function') {
    callback({ ok: false, error: message });
  }
}

function getConversationEntity(type, id) {
  if (type === 'room') {
    return store.rooms[id] || null;
  }

  if (type === 'personal') {
    return store.personalChats[id] || null;
  }

  return null;
}

function upsertReaction(message, emoji, session) {
  if (!Array.isArray(message.reactions)) {
    message.reactions = [];
  }

  const existingIndex = message.reactions.findIndex(reaction => reaction.phone === session.phone);

  if (existingIndex >= 0) {
    if (message.reactions[existingIndex].emoji === emoji) {
      message.reactions.splice(existingIndex, 1);
      return;
    }

    message.reactions[existingIndex] = {
      emoji,
      phone: session.phone,
      name: session.name
    };
    return;
  }

  message.reactions.push({
    emoji,
    phone: session.phone,
    name: session.name
  });
}

const store = loadStore();
const phoneToSockets = new Map();
const sessions = new Map();

const app = express();
const PUBLIC_DIR = path.join(__dirname, '..');

app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

io.on('connection', socket => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('register-user', (payload, callback) => {
    const name = String(payload?.name || '').trim();
    const phone = normalizePhone(payload?.phone);

    if (!name) {
      return sendConversationError(callback, 'Please enter your name.');
    }

    if (phone.length < 7) {
      return sendConversationError(callback, 'Please enter a valid phone number.');
    }

    sessions.set(socket.id, {
      socketId: socket.id,
      name,
      phone,
      activeConversationKey: null
    });

    addSocketForPhone(phone, socket.id);
    updateStoredUser(name, phone);

    if (typeof callback === 'function') {
      callback({
        ok: true,
        user: { name, phone },
        personalChats: getPersonalChatList(phone)
      });
    }
  });

  socket.on('verify-user', (payload, callback) => {
    const phone = normalizePhone(payload?.phone);
    const name = String(payload?.name || '').trim();

    if (phone.length < 7) {
      return sendConversationError(callback, 'Saved phone number is invalid.');
    }

    const storedUser = getStoredUser(phone);

    if (!storedUser) {
      return sendConversationError(callback, 'No saved account found for this phone number.');
    }

    if (name && storedUser.name !== name) {
      return sendConversationError(callback, 'Saved identity does not match server records.');
    }

    sessions.set(socket.id, {
      socketId: socket.id,
      name: storedUser.name,
      phone: storedUser.phone,
      activeConversationKey: null
    });

    addSocketForPhone(storedUser.phone, socket.id);
    updateStoredUser(storedUser.name, storedUser.phone);

    if (typeof callback === 'function') {
      callback({
        ok: true,
        user: {
          name: storedUser.name,
          phone: storedUser.phone
        },
        personalChats: getPersonalChatList(storedUser.phone)
      });
    }
  });

  socket.on('join-room', (payload, callback) => {
    const session = sessions.get(socket.id);

    if (!session) {
      return sendConversationError(callback, 'Register before joining a room.');
    }

    const roomCode = normalizeRoomCode(payload?.roomCode);
    const roomName = String(payload?.roomName || roomCode).trim() || roomCode;

    if (!roomCode) {
      return sendConversationError(callback, 'Please enter a room code.');
    }

    const room = getRoomConversation(roomCode);
    room.name = roomName;

    const conversationKey = formatConversationKey('room', room.id);
    leaveActiveConversation(socket);
    session.activeConversationKey = conversationKey;
    socket.join(getConversationRoom(conversationKey));

    const systemMessage = createMessage({
      senderName: 'System',
      senderPhone: '',
      text: `${session.name} joined the room.`,
      system: true
    });

    room.messages.push(systemMessage);
    saveStore();

    socket.to(getConversationRoom(conversationKey)).emit('message:new', {
      conversationKey,
      message: systemMessage
    });

    if (typeof callback === 'function') {
      callback({
        ok: true,
        conversation: getConversationPayload('room', room, session.phone)
      });
    }
  });

  socket.on('open-personal-chat', (payload, callback) => {
    const session = sessions.get(socket.id);

    if (!session) {
      return sendConversationError(callback, 'Register before starting a personal chat.');
    }

    const targetPhone = normalizePhone(payload?.targetPhone);

    if (targetPhone.length < 7) {
      return sendConversationError(callback, 'Please enter a valid target phone number.');
    }

    if (targetPhone === session.phone) {
      return sendConversationError(callback, 'Use a different phone number for personal chat.');
    }

    const personalChat = getPersonalConversation(session.phone, targetPhone);
    const conversationKey = formatConversationKey('personal', personalChat.id);

    leaveActiveConversation(socket);
    session.activeConversationKey = conversationKey;
    socket.join(getConversationRoom(conversationKey));

    if (typeof callback === 'function') {
      callback({
        ok: true,
        conversation: getConversationPayload('personal', personalChat, session.phone),
        personalChats: getPersonalChatList(session.phone)
      });
    }
  });

  socket.on('get-personal-chats', (callback) => {
    const session = sessions.get(socket.id);

    if (!session) {
      return sendConversationError(callback, 'Register before loading chats.');
    }

    if (typeof callback === 'function') {
      callback({
        ok: true,
        personalChats: getPersonalChatList(session.phone)
      });
    }
  });

  socket.on('send-message', (payload, callback) => {
    const session = sessions.get(socket.id);

    if (!session) {
      return sendConversationError(callback, 'Register before sending messages.');
    }

    const conversationKey = String(payload?.conversationKey || '');
    const text = String(payload?.text || '').trim();

    if (!conversationKey) {
      return sendConversationError(callback, 'Open a conversation first.');
    }

    if (!text) {
      return sendConversationError(callback, 'Message cannot be empty.');
    }

    const [type, id] = conversationKey.split(':');

    if (type === 'room') {
      const room = store.rooms[id];

      if (!room) {
        return sendConversationError(callback, 'Room not found.');
      }

      const message = createMessage({
        senderName: session.name,
        senderPhone: session.phone,
        text
      });

      room.messages.push(message);
      saveStore();

      io.to(getConversationRoom(conversationKey)).emit('message:new', {
        conversationKey,
        message
      });
    } else if (type === 'personal') {
      const chat = store.personalChats[id];

      if (!chat || !isPhoneInPersonalChat(chat, session.phone)) {
        return sendConversationError(callback, 'Personal chat not found.');
      }

      const message = createMessage({
        senderName: session.name,
        senderPhone: session.phone,
        text
      });

      chat.messages.push(message);
      saveStore();

      io.to(getConversationRoom(conversationKey)).emit('message:new', {
        conversationKey,
        message
      });
    } else {
      return sendConversationError(callback, 'Invalid conversation type.');
    }

    if (typeof callback === 'function') {
      callback({ ok: true });
    }
  });

  socket.on('react-message', (payload, callback) => {
    const session = sessions.get(socket.id);

    if (!session) {
      return sendConversationError(callback, 'Register before reacting to messages.');
    }

    const conversationKey = String(payload?.conversationKey || '');
    const messageId = String(payload?.messageId || '');
    const emoji = String(payload?.emoji || '').trim();

    if (!conversationKey || !messageId || !emoji) {
      return sendConversationError(callback, 'Reaction details are incomplete.');
    }

    const [type, id] = conversationKey.split(':');
    const entity = getConversationEntity(type, id);

    if (!entity) {
      return sendConversationError(callback, 'Conversation not found.');
    }

    if (type === 'personal' && !isPhoneInPersonalChat(entity, session.phone)) {
      return sendConversationError(callback, 'Personal chat not found.');
    }

    const message = entity.messages.find(item => item.id === messageId);

    if (!message || message.system) {
      return sendConversationError(callback, 'Message not found for reaction.');
    }

    upsertReaction(message, emoji, session);
    saveStore();

    io.to(getConversationRoom(conversationKey)).emit('message:reaction', {
      conversationKey,
      messageId,
      reactions: message.reactions
    });

    if (typeof callback === 'function') {
      callback({ ok: true, reactions: message.reactions });
    }
  });

  socket.on('typing:start', payload => {
    const session = sessions.get(socket.id);
    const conversationKey = String(payload?.conversationKey || '');

    if (!session || !conversationKey) {
      return;
    }

    socket.to(getConversationRoom(conversationKey)).emit('typing:update', {
      conversationKey,
      isTyping: true,
      name: session.name
    });
  });

  socket.on('typing:stop', payload => {
    const session = sessions.get(socket.id);
    const conversationKey = String(payload?.conversationKey || '');

    if (!session || !conversationKey) {
      return;
    }

    socket.to(getConversationRoom(conversationKey)).emit('typing:update', {
      conversationKey,
      isTyping: false,
      name: session.name
    });
  });

  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);

    if (session) {
      const { activeConversationKey, name, phone } = session;

      if (activeConversationKey) {
        const [type, id] = activeConversationKey.split(':');

        if (type === 'room' && store.rooms[id]) {
          const systemMessage = createMessage({
            senderName: 'System',
            senderPhone: '',
            text: `${name} left the room.`,
            system: true
          });

          store.rooms[id].messages.push(systemMessage);
          saveStore();

          socket.to(getConversationRoom(activeConversationKey)).emit('message:new', {
            conversationKey: activeConversationKey,
            message: systemMessage
          });
        }
      }

      removeSocketForPhone(phone, socket.id);
      sessions.delete(socket.id);
    }

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

httpServer.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or start with a different port using: $env:PORT=<port>; npm run dev`);
    return;
  }

  console.error('Server failed to start:', error);
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}...`);
});
