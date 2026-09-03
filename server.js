const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const OBSWebSocket = require('obs-websocket-js').default || require('obs-websocket-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const obs = new OBSWebSocket();

const PORT = process.env.PORT || 3000;
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || 'rccgdirector2026';

// Global Production State
const state = {
  programStatus: 'Not Started',
  countdown: { targetTime: null, active: false, remaining: 0 },
  previewCamera: 'camera1',
  liveCamera: 'camera1',
  cameraMap: {
    camera1: 'Camera 1',
    camera2: 'Camera 2',
    camera3: 'Camera 3',
    camera4: 'Camera 4'
  },
  announcement: '',
  instructions: [],
  urgentAlert: null,
  messages: [],
  activityLog: [],
  connectedUsers: {},
  obs: {
    connected: false,
    currentScene: '',
    streaming: false,
    recording: false,
    scenes: []
  }
};

function logActivity(text) {
  const entry = { time: new Date().toLocaleTimeString(), text };
  state.activityLog.unshift(entry);
  if (state.activityLog.length > 50) state.activityLog.pop();
  io.emit('activity:new', entry);
}

// Serve Static Files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Explicit Route Handlers
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/director', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'director.html'));
});

app.get('/obs-output', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'obs-output.html'));
});

// Authentication Endpoint
app.post('/api/director/login', (req, res) => {
  const { password } = req.body;
  if (password === DIRECTOR_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

// OBS Integration Logic
async function connectOBS(url, password) {
  try {
    const wsUrl = url || process.env.OBS_WEBSOCKET_URL;
    const wsPassword = password !== undefined ? password : process.env.OBS_WEBSOCKET_PASSWORD;
    if (!wsUrl) return;

    await obs.connect(wsUrl, wsPassword);
    state.obs.connected = true;
    logActivity('OBS WebSocket connected successfully');

    // Fetch initial scenes
    const sceneList = await obs.call('GetSceneList');
    state.obs.scenes = sceneList.scenes.map(s => s.sceneName);
    state.obs.currentScene = sceneList.currentProgramSceneName;

    const streamStatus = await obs.call('GetStreamStatus');
    state.obs.streaming = streamStatus.outputActive;

    const recordStatus = await obs.call('GetRecordStatus');
    state.obs.recording = recordStatus.outputActive;

    io.emit('state:update', state);
  } catch (err) {
    state.obs.connected = false;
    logActivity(`OBS Connection Error: ${err.message}`);
    io.emit('state:update', state);
  }
}

// OBS Event Listeners
obs.on('CurrentProgramSceneChanged', data => {
  state.obs.currentScene = data.sceneName;
  // Reverse lookup camera if matched
  for (const [key, name] of Object.entries(state.cameraMap)) {
    if (name === data.sceneName) {
      state.liveCamera = key;
      break;
    }
  }
  logActivity(`OBS Program Scene Changed: ${data.sceneName}`);
  io.emit('state:update', state);
});

obs.on('StreamStateChanged', data => {
  state.obs.streaming = data.outputActive;
  logActivity(`Stream state changed: ${data.outputActive ? 'LIVE' : 'OFFLINE'}`);
  io.emit('state:update', state);
});

obs.on('RecordStateChanged', data => {
  state.obs.recording = data.outputActive;
  logActivity(`Recording state changed: ${data.outputActive ? 'RECORDING' : 'OFF'}`);
  io.emit('state:update', state);
});

// Socket.IO Connection Handler
io.on('connection', (socket) => {
  socket.emit('state:update', state);

  socket.on('user:join', (data) => {
    state.connectedUsers[socket.id] = {
      id: socket.id,
      name: data.name || 'Anonymous',
      department: data.department || 'Other',
      joinedAt: new Date().toLocaleTimeString()
    };
    logActivity(`${data.name} (${data.department}) joined the production session`);
    io.emit('state:update', state);
  });

  socket.on('director:set-status', (status) => {
    state.programStatus = status;
    logActivity(`Program status updated: ${status}`);
    io.emit('state:update', state);
  });

  socket.on('director:preview-camera', (camKey) => {
    state.previewCamera = camKey;
    io.emit('state:update', state);
  });

  socket.on('director:take-live', async () => {
    state.liveCamera = state.previewCamera;
    logActivity(`TAKE LIVE: ${state.liveCamera.toUpperCase()}`);
    io.emit('state:update', state);

    if (state.obs.connected) {
      const targetScene = state.cameraMap[state.liveCamera];
      if (targetScene) {
        try {
          await obs.call('SetCurrentProgramScene', { sceneName: targetScene });
        } catch (err) {
          logActivity(`OBS Switch Failed: ${err.message}`);
        }
      }
    }
  });

  socket.on('director:cut-live', async (camKey) => {
    state.previewCamera = camKey;
    state.liveCamera = camKey;
    logActivity(`CUT LIVE: ${camKey.toUpperCase()}`);
    io.emit('state:update', state);

    if (state.obs.connected) {
      const targetScene = state.cameraMap[camKey];
      if (targetScene) {
        try {
          await obs.call('SetCurrentProgramScene', { sceneName: targetScene });
        } catch (err) {
          logActivity(`OBS Switch Failed: ${err.message}`);
        }
      }
    }
  });

  socket.on('director:announcement', (text) => {
    state.announcement = text;
    logActivity(`Announcement sent: "${text}"`);
    io.emit('state:update', state);
  });

  socket.on('director:instruction', (data) => {
    const item = {
      id: Date.now(),
      department: data.department,
      text: data.text,
      time: new Date().toLocaleTimeString(),
      acknowledgements: []
    };
    state.instructions.unshift(item);
    logActivity(`Instruction to ${data.department}: "${data.text}"`);
    io.emit('state:update', state);
  });

  socket.on('team:acknowledge', (instructionId) => {
    const user = state.connectedUsers[socket.id];
    if (!user) return;
    const inst = state.instructions.find(i => i.id === instructionId);
    if (inst && !inst.acknowledgements.some(a => a.userId === socket.id)) {
      inst.acknowledgements.push({
        userId: socket.id,
        name: user.name,
        department: user.department,
        time: new Date().toLocaleTimeString()
      });
      logActivity(`${user.name} acknowledged instruction #${instructionId}`);
      io.emit('state:update', state);
    }
  });

  socket.on('director:urgent-alert', (text) => {
    state.urgentAlert = text ? { text, time: new Date().toLocaleTimeString() } : null;
    logActivity(text ? `URGENT ALERT: ${text}` : 'Urgent alert cleared');
    io.emit('state:update', state);
  });

  socket.on('team:message', (text) => {
    const user = state.connectedUsers[socket.id] || { name: 'Anonymous', department: 'Other' };
    const msg = {
      id: Date.now(),
      sender: user.name,
      department: user.department,
      text,
      time: new Date().toLocaleTimeString()
    };
    state.messages.unshift(msg);
    logActivity(`Message from ${user.name}: "${text}"`);
    io.emit('state:update', state);
  });

  socket.on('obs:config', (data) => {
    connectOBS(data.url, data.password);
  });

  socket.on('disconnect', () => {
    const user = state.connectedUsers[socket.id];
    if (user) {
      logActivity(`${user.name} disconnected`);
      delete state.connectedUsers[socket.id];
      io.emit('state:update', state);
    }
  });
});

// Start Server & Attempt Automatic OBS Connection
server.listen(PORT, () => {
  console.log(`CHURCH LIVE STUDIO running at http://localhost:${PORT}`);
  connectOBS();
});