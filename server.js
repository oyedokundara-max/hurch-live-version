const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const OBSWebSocket = require('obs-websocket-js');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 10000;
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || 'change-me';

const DEPARTMENTS = [
  'Director',
  'Camera',
  'Audio',
  'Projection',
  'Streaming',
  'Media',
  'Lighting',
  'Technical',
  'Other'
];

const PROGRAM_STATUSES = [
  'Not Started',
  'Preparation',
  'Sound Check',
  'Camera Check',
  'Countdown',
  'Live',
  'Worship',
  'Sermon',
  'Prayer',
  'Offering',
  'Announcements',
  'Closing',
  'Ended'
];

const CAMERA_KEYS = ['camera1', 'camera2', 'camera3', 'camera4'];

const state = {
  users: [],
  programStatus: 'Not Started',
  announcement: null,
  instructions: [],
  urgentAlerts: [],
  messages: [],
  countdown: {
    duration: 60,
    remaining: 60,
    running: false,
    startedAt: null,
    startedBy: null
  },
  programOutput: {
    preview: 'camera1',
    live: 'camera1',
    lastAction: 'Initialized',
    updatedAt: new Date().toISOString()
  },
  activity: [],
  obs: {
    connected: false,
    host: process.env.OBS_HOST || '',
    port: process.env.OBS_PORT || '',
    password: process.env.OBS_PASSWORD || '',
    previewUrl: process.env.OBS_PREVIEW_URL || '',
    currentScene: 'Unknown',
    previewScene: null,
    streamState: 'offline',
    recordingState: 'off',
    scenes: [],
    transitions: [],
    sources: [],
    currentTransition: '',
    lastError: '',
    cameraMappings: {
      camera1: '',
      camera2: '',
      camera3: '',
      camera4: ''
    },
    sceneMappings: {
      Worship: '',
      Sermon: '',
      Prayer: '',
      Offering: '',
      Announcements: '',
      Closing: ''
    },
    autoSceneSwitch: true,
    connectedAt: null
  }
};

let obsClient = null;

function getStatePayload() {
  return {
    users: [...state.users],
    programStatus: state.programStatus,
    announcement: state.announcement,
    instructions: [...state.instructions],
    urgentAlerts: [...state.urgentAlerts],
    messages: [...state.messages],
    countdown: { ...state.countdown },
    programOutput: { ...state.programOutput },
    activity: [...state.activity].slice(-20),
    obs: {
      ...state.obs,
      host: state.obs.host || 'Not configured',
      port: state.obs.port || 'Not configured',
      connected: !!state.obs.connected,
      streamState: state.obs.streamState || 'offline',
      recordingState: state.obs.recordingState || 'off',
      currentScene: state.obs.currentScene || 'Unknown',
      previewScene: state.obs.previewScene || null,
      lastError: state.obs.lastError || ''
    },
    departments: DEPARTMENTS,
    programStatuses: PROGRAM_STATUSES
  };
}

function addActivity(event, details = '') {
  state.activity.push({
    id: Date.now() + Math.random().toString(16).slice(2),
    event,
    details,
    timestamp: new Date().toISOString()
  });
  if (state.activity.length > 60) {
    state.activity = state.activity.slice(-60);
  }
}

function broadcastState() {
  io.emit('state:update', getStatePayload());
}

function sanitizeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function getEntryPoint() {
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'live', 'index.html')
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function getHTMLPage(pageName) {
  const possiblePaths = [
    path.join(__dirname, 'public', pageName),
    path.join(__dirname, pageName)
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

// Middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static file serving
if (fs.existsSync(path.join(__dirname, 'public'))) {
  app.use(express.static(path.join(__dirname, 'public')));
}
app.use(express.static(__dirname));

// --- SPECIFIC ROUTES FIRST ---
app.get('/director', (req, res) => {
  const page = getHTMLPage('director.html');
  if (page) return res.sendFile(page);
  res.status(404).send('director.html not found.');
});

app.get('/control-room', (req, res) => {
  const page = getHTMLPage('director.html');
  if (page) return res.sendFile(page);
  res.status(404).send('director.html not found.');
});

app.get('/obs-output', (req, res) => {
  const page = getHTMLPage('obs-output.html');
  if (page) return res.sendFile(page);
  res.status(404).send('obs-output.html not found.');
});

app.get('/director/session', (req, res) => {
  const authorized = req.cookies.directorAuth === 'true';
  res.json({ authorized, hasPassword: Boolean(DIRECTOR_PASSWORD) });
});

app.post('/director/login', (req, res) => {
  const enteredPassword = sanitizeText(req.body.password || '', '');

  if (!enteredPassword || enteredPassword !== DIRECTOR_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid director password.' });
  }

  res.cookie('directorAuth', 'true', {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 60 * 60 * 1000
  });

  return res.json({ success: true, message: 'Director access granted.' });
});

app.post('/director/logout', (req, res) => {
  res.clearCookie('directorAuth');
  res.json({ success: true });
});

app.get('/api/state', (req, res) => {
  res.json(getStatePayload());
});

app.get('/api/program-state', (req, res) => {
  res.json({ programOutput: state.programOutput });
});

// --- CATCH-ALL ROUTE LAST ---
app.get('*', (req, res) => {
  const entryPath = getEntryPoint();
  if (entryPath) {
    return res.sendFile(entryPath);
  }
  res.status(404).send('Main index.html file not found.');
});

// Socket.IO Handlers
io.on('connection', (socket) => {
  socket.emit('state:update', getStatePayload());

  socket.on('join:team', (payload) => {
    const name = sanitizeText(payload?.name || '', '');
    const department = sanitizeText(payload?.department || '', 'Other');

    if (!name) {
      return socket.emit('error:message', { message: 'A name is required.' });
    }

    const user = {
      socketId: socket.id,
      name,
      department,
      connected: true,
      joinedAt: new Date().toISOString()
    };

    state.users.push(user);
    addActivity('User joined', `${name} (${department}) joined.`);
    broadcastState();
  });

  socket.on('send:message', (payload) => {
    const messageText = sanitizeText(payload?.message || '', '');
    if (!messageText) return;

    const sender = state.users.find((m) => m.socketId === socket.id);
    state.messages.push({
      id: Date.now().toString(16),
      sender: sender ? sender.name : 'Unknown',
      department: sender ? sender.department : 'Other',
      message: messageText,
      timestamp: new Date().toISOString()
    });
    broadcastState();
  });

  socket.on('send:announcement', (payload) => {
    const text = sanitizeText(payload?.text || '', '');
    if (!text) return;

    state.announcement = {
      id: Date.now().toString(16),
      text,
      timestamp: new Date().toISOString()
    };
    addActivity('Announcement updated', text);
    broadcastState();
  });

  socket.on('disconnect', () => {
    const index = state.users.findIndex((m) => m.socketId === socket.id);
    if (index >= 0) {
      const removed = state.users.splice(index, 1)[0];
      addActivity('User disconnected', `${removed.name} disconnected.`);
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`CHURCH LIVE STUDIO server running on port ${PORT}`);
});