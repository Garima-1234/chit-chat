const socket = io();

const state = {
  user: null,
  activeConversation: null,
  typingTimeout: null
};

const IDENTITY_STORAGE_KEY = 'orbit-chat-user';

const homeScreen = document.getElementById('home-screen');
const chatScreen = document.getElementById('chat-screen');
const registerForm = document.getElementById('register-form');
const nameInput = document.getElementById('name-input');
const phoneInput = document.getElementById('phone-input');
const roomForm = document.getElementById('room-form');
const roomCodeInput = document.getElementById('room-code-input');
const roomNameInput = document.getElementById('room-name-input');
const personalForm = document.getElementById('personal-form');
const targetPhoneInput = document.getElementById('target-phone-input');
const savedPersonalChats = document.getElementById('saved-personal-chats');
const savedChatsCount = document.getElementById('saved-chats-count');
const authPanel = document.getElementById('auth-panel');
const actionPanel = document.getElementById('action-panel');
const emptyState = document.getElementById('empty-state');
const conversationPanel = document.getElementById('conversation-panel');
const chatTitle = document.getElementById('chat-title');
const chatSubtitle = document.getElementById('chat-subtitle');
const profileName = document.getElementById('profile-name');
const profilePhone = document.getElementById('profile-phone');
const messagesList = document.getElementById('messages');
const messageForm = document.getElementById('send-container');
const messageInput = document.getElementById('messageInp');
const emojiButton = document.getElementById('emoji-btn');
const emojiPicker = document.getElementById('emoji-picker');
const sendButton = document.getElementById('btnh');
const typingIndicator = document.getElementById('typing-indicator');
const statusLine = document.getElementById('status-line');
const backButton = document.getElementById('back-btn');
const audio = new Audio('ting.mp3');
const EMOJIS = ['😀', '😂', '😍', '🥳', '😎', '🤝', '🔥', '❤️', '👍', '🙌', '🎉', '😄'];
const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function saveIdentity(user) {
  localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(user));
}

function loadSavedIdentity() {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) || 'null');
  } catch (error) {
    localStorage.removeItem(IDENTITY_STORAGE_KEY);
    return null;
  }
}

function clearSavedIdentity() {
  localStorage.removeItem(IDENTITY_STORAGE_KEY);
}

function setStatus(message, isError = false) {
  statusLine.textContent = message;
  statusLine.dataset.error = isError ? 'true' : 'false';
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function clearMessages() {
  messagesList.innerHTML = '';
}

function getReactionSummary(reactions = []) {
  const grouped = new Map();

  reactions.forEach(reaction => {
    if (!grouped.has(reaction.emoji)) {
      grouped.set(reaction.emoji, []);
    }

    grouped.get(reaction.emoji).push(reaction);
  });

  return Array.from(grouped.entries()).map(([emoji, items]) => ({
    emoji,
    count: items.length,
    isOwn: items.some(item => state.user && item.phone === state.user.phone)
  }));
}

function applyReactionBar(container, reactions = []) {
  container.innerHTML = '';
  const summary = getReactionSummary(reactions);
  const messageCard = container.closest('.message-card');

  if (!summary.length) {
    container.hidden = true;
    if (messageCard) {
      messageCard.classList.remove('has-reactions');
    }
    return;
  }

  container.hidden = false;
  if (messageCard) {
    messageCard.classList.add('has-reactions');
  }

  summary.forEach(item => {
    const pill = document.createElement('span');
    pill.className = `reaction-pill${item.isOwn ? ' is-own' : ''}`;
    pill.textContent = `${item.emoji} ${item.count}`;
    container.appendChild(pill);
  });
}

function toggleReaction(messageId, emoji) {
  if (!state.activeConversation) {
    return;
  }

  socket.emit('react-message', {
    conversationKey: state.activeConversation.key,
    messageId,
    emoji
  });
}

function updateMessageReactions(messageId, reactions) {
  const messageCard = messagesList.querySelector(`[data-id="${messageId}"]`);

  if (!messageCard) {
    return;
  }

  const reactionBar = messageCard.querySelector('.reaction-bar');
  if (!reactionBar) {
    return;
  }

  applyReactionBar(reactionBar, reactions);
}

function hideEmojiPicker() {
  emojiPicker.hidden = true;
}

function buildEmojiPicker() {
  emojiPicker.innerHTML = '';

  EMOJIS.forEach(emoji => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-option';
    button.textContent = emoji;
    button.addEventListener('click', () => {
      messageInput.value += emoji;
      messageInput.focus();
      hideEmojiPicker();
    });
    emojiPicker.appendChild(button);
  });
}

function renderPersonalChatList(chats = []) {
  savedPersonalChats.innerHTML = '';
  savedChatsCount.textContent = `${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}`;

  if (!chats.length) {
    const empty = document.createElement('div');
    empty.className = 'saved-empty';
    empty.textContent = 'No connected personal chats yet. Open one and it will appear here.';
    savedPersonalChats.appendChild(empty);
    return;
  }

  chats.forEach(chat => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-chat-card';
    button.dataset.phone = chat.targetPhone;
    const initials = (chat.title || chat.targetPhone)
      .split(' ')
      .map(part => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    button.innerHTML = `
      <div class="saved-chat-top">
        <div class="saved-chat-avatar">${initials}</div>
        <div class="saved-chat-copy">
          <strong>${chat.title}</strong>
          <span class="saved-chat-subtitle">${chat.subtitle}</span>
        </div>
      </div>
      <span class="saved-chat-preview">${chat.preview}</span>
    `;

    button.addEventListener('click', () => {
      targetPhoneInput.value = chat.targetPhone;
      openPersonalChat(chat.targetPhone);
    });

    savedPersonalChats.appendChild(button);
  });
}

function showHomeScreen() {
  homeScreen.hidden = false;
  chatScreen.hidden = true;
}

function showChatScreen() {
  homeScreen.hidden = true;
  chatScreen.hidden = false;
}

function isOwnMessage(message) {
  return state.user && message.senderPhone === state.user.phone;
}

function renderMessage(message, shouldPlaySound = false) {
  const item = document.createElement('article');
  const ownMessage = isOwnMessage(message);
  item.className = `message-card ${message.system ? 'system' : ownMessage ? 'outgoing' : 'incoming'}`;
  item.dataset.id = message.id;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = message.system
    ? 'System'
    : `${message.senderName} ${message.senderPhone ? `- ${message.senderPhone}` : ''}`;

  const body = document.createElement('p');
  body.className = 'message-text';
  body.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message-time';
  time.textContent = formatTime(message.sentAt);

  const main = document.createElement('div');
  main.className = 'message-main';
  main.append(meta, body);

  if (!message.system && !ownMessage) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'reaction-launcher';
    launcher.textContent = '😊';

    const reactionMenu = document.createElement('div');
    reactionMenu.className = 'reaction-menu';
    reactionMenu.hidden = true;

    launcher.addEventListener('click', event => {
      event.stopPropagation();
      const willOpen = reactionMenu.hidden;
      document.querySelectorAll('.reaction-menu').forEach(menu => {
        menu.hidden = true;
      });
      document.querySelectorAll('.message-card.menu-open').forEach(card => {
        card.classList.remove('menu-open');
      });
      reactionMenu.hidden = !willOpen;
      item.classList.toggle('menu-open', willOpen);
    });

    MESSAGE_REACTIONS.forEach(emoji => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'reaction-option';
      option.textContent = emoji;
      option.addEventListener('click', event => {
        event.stopPropagation();
        toggleReaction(message.id, emoji);
        reactionMenu.hidden = true;
        item.classList.remove('menu-open');
      });
      reactionMenu.appendChild(option);
    });

    actions.append(launcher, reactionMenu);
    item.appendChild(actions);
  }

  const reactionBar = document.createElement('div');
  reactionBar.className = 'reaction-bar';
  applyReactionBar(reactionBar, message.reactions || []);

  main.append(time);
  item.append(main, reactionBar);
  messagesList.appendChild(item);
  messagesList.scrollTop = messagesList.scrollHeight;

  if (shouldPlaySound && !message.system && !isOwnMessage(message)) {
    audio.play().catch(() => {});
  }
}

function renderHistory(history) {
  clearMessages();

  if (!history.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'history-placeholder';
    placeholder.textContent = 'No messages yet. Start the conversation.';
    messagesList.appendChild(placeholder);
    return;
  }

  history.forEach(message => renderMessage(message));
}

function showConversation(conversation) {
  state.activeConversation = conversation;
  chatTitle.textContent = conversation.title;
  chatSubtitle.textContent = conversation.subtitle;
  messageInput.disabled = false;
  emojiButton.disabled = false;
  sendButton.disabled = false;
  typingIndicator.hidden = true;
  renderHistory(conversation.history || []);
  showChatScreen();
}

function setUser(user, personalChats = []) {
  state.user = user;
  saveIdentity(user);
  profileName.textContent = user.name;
  profilePhone.textContent = user.phone;
  nameInput.value = user.name;
  phoneInput.value = user.phone;
  authPanel.hidden = true;
  actionPanel.hidden = false;
  renderPersonalChatList(personalChats);
  setStatus('Choose a room or open a personal chat.');
}

function showRegisterForm() {
  state.user = null;
  authPanel.hidden = false;
  actionPanel.hidden = true;
  profileName.textContent = 'Guest User';
  profilePhone.textContent = 'Register with your phone number to begin.';
  showHomeScreen();
}

function leaveConversationView() {
  state.activeConversation = null;
  messageInput.disabled = true;
  emojiButton.disabled = true;
  sendButton.disabled = true;
  messageInput.value = '';
  typingIndicator.hidden = true;
  typingIndicator.textContent = '';
  hideEmojiPicker();
  clearMessages();
  showHomeScreen();
}

function refreshPersonalChatList() {
  socket.emit('get-personal-chats', response => {
    if (!response?.ok) {
      return;
    }

    renderPersonalChatList(response.personalChats || []);
  });
}

function openPersonalChat(phone) {
  socket.emit(
    'open-personal-chat',
    { targetPhone: phone },
    response => {
      if (!response?.ok) {
        setStatus(response?.error || 'Unable to open personal chat.', true);
        return;
      }

      showConversation(response.conversation);
      renderPersonalChatList(response.personalChats || []);
      setStatus(`Personal chat ready with ${response.conversation.subtitle.replace('Phone: ', '')}.`);
    }
  );
}

function validateRegistered() {
  if (!state.user) {
    setStatus('Register first to continue.', true);
    return false;
  }

  return true;
}

function emitTypingStart() {
  if (!state.activeConversation) {
    return;
  }

  socket.emit('typing:start', {
    conversationKey: state.activeConversation.key
  });
}

function emitTypingStop() {
  if (!state.activeConversation) {
    return;
  }

  socket.emit('typing:stop', {
    conversationKey: state.activeConversation.key
  });
}

registerForm.addEventListener('submit', event => {
  event.preventDefault();

  const payload = {
    name: nameInput.value.trim(),
    phone: phoneInput.value.trim()
  };

  socket.emit('register-user', payload, response => {
    if (!response?.ok) {
      setStatus(response?.error || 'Unable to register.', true);
      return;
    }

    setUser(response.user, response.personalChats || []);
  });
});

roomForm.addEventListener('submit', event => {
  event.preventDefault();

  if (!validateRegistered()) {
    return;
  }

  const payload = {
    roomCode: roomCodeInput.value.trim(),
    roomName: roomNameInput.value.trim()
  };

  socket.emit('join-room', payload, response => {
    if (!response?.ok) {
      setStatus(response?.error || 'Unable to join room.', true);
      return;
    }

    showConversation(response.conversation);
    setStatus(`Joined room ${response.conversation.id}.`);
  });
});

personalForm.addEventListener('submit', event => {
  event.preventDefault();

  if (!validateRegistered()) {
    return;
  }

  openPersonalChat(targetPhoneInput.value.trim());
});

messageForm.addEventListener('submit', event => {
  event.preventDefault();

  if (!state.activeConversation) {
    setStatus('Open a room or personal chat first.', true);
    return;
  }

  const text = messageInput.value.trim();

  if (!text) {
    return;
  }

  socket.emit(
    'send-message',
    {
      conversationKey: state.activeConversation.key,
      text
    },
    response => {
      if (!response?.ok) {
        setStatus(response?.error || 'Message could not be sent.', true);
        return;
      }

      messageInput.value = '';
      emitTypingStop();
    }
  );
});

messageInput.addEventListener('input', () => {
  if (!state.activeConversation) {
    return;
  }

  emitTypingStart();
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    emitTypingStop();
  }, 1200);
});

emojiButton.addEventListener('click', () => {
  if (emojiButton.disabled) {
    return;
  }

  emojiPicker.hidden = !emojiPicker.hidden;
});

backButton.addEventListener('click', () => {
  emitTypingStop();
  leaveConversationView();
  refreshPersonalChatList();
});

socket.on('message:new', payload => {
  if (!state.activeConversation || payload.conversationKey !== state.activeConversation.key) {
    return;
  }

  const placeholder = messagesList.querySelector('.history-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  renderMessage(payload.message, true);
});

socket.on('typing:update', payload => {
  if (!state.activeConversation || payload.conversationKey !== state.activeConversation.key) {
    return;
  }

  if (!payload.isTyping) {
    typingIndicator.hidden = true;
    typingIndicator.textContent = '';
    return;
  }

  typingIndicator.hidden = false;
  typingIndicator.textContent = `${payload.name} is typing...`;
});

socket.on('message:reaction', payload => {
  if (!state.activeConversation || payload.conversationKey !== state.activeConversation.key) {
    return;
  }

  updateMessageReactions(payload.messageId, payload.reactions || []);
});

socket.on('connect', () => {
  const savedIdentity = loadSavedIdentity();

  if (!savedIdentity) {
    showRegisterForm();
    setStatus('Connected to chat server.');
    return;
  }

  socket.emit('verify-user', savedIdentity, response => {
    if (!response?.ok) {
      clearSavedIdentity();
      showRegisterForm();
      setStatus(response?.error || 'Please register again.', true);
      return;
    }

    setUser(response.user, response.personalChats || []);
    setStatus('Identity restored from saved account.');
  });
});

socket.on('disconnect', () => {
  setStatus('Disconnected from server. Refresh after server is back.', true);
});

document.addEventListener('click', event => {
  if (!emojiPicker.contains(event.target) && event.target !== emojiButton) {
    hideEmojiPicker();
  }

  if (!event.target.closest('.message-actions')) {
    document.querySelectorAll('.reaction-menu').forEach(menu => {
      menu.hidden = true;
    });
    document.querySelectorAll('.message-card.menu-open').forEach(card => {
      card.classList.remove('menu-open');
    });
  }
});

buildEmojiPicker();
