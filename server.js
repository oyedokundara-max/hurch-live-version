const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const OBSWebSocket = require('obs-websocket-js');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;
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
let obsConnectionTimer = null;

function getStatePayload() {
  return {
    users: [...state.users],
    programStatus: state.programStatus,
    announcement: state.announcement,
    instructions: [...state.instructions],
    urgentAlerts: [...state.urgentAlerts],
    messages: [...state.messages],
    countdown: { ...state.countdown },
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
  const payload = getStatePayload();
  io.emit('state:update', payload);
}

function sanitizeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function updateCountdownClock() {
  if (!state.countdown.running) return;
  const timestamp = Date.now();
  const elapsedSeconds = Math.floor((timestamp - (state.countdown.startedAt || timestamp)) / 1000);
  const remaining = Math.max(0, state.countdown.duration - elapsedSeconds);

  state.countdown.remaining = remaining;
  if (remaining <= 0) {
    state.countdown.running = false;
    addActivity('Countdown completed', `Duration reached: ${state.countdown.duration}s`);
  }
  broadcastState();
}

setInterval(updateCountdownClock, 1000);

function syncProgramSceneToStatus(statusName) {
  if (!state.obs.autoSceneSwitch) return;
  const mappedName = state.obs.sceneMappings[statusName];
  if (!mappedName) return;

  if (obsClient && state.obs.connected) {
    takeObsScene(mappedName, { silent: true, source: 'program-status' });
  }
}

async function updateObsState() {
  try {
    const hasObs = !!obsClient && state.obs.connected;
    if (!hasObs) {
      state.obs.currentScene = 'Unknown';
      state.obs.streamState = 'offline';
      state.obs.recordingState = 'off';
      state.obs.scenes = [];
      state.obs.transitions = [];
      state.obs.sources = [];
      return;
    }

    const [sceneList, transitionList, streamStatus, recordStatus] = await Promise.all([
      obsClient.call('GetSceneList').catch(() => ({ scenes: [] })),
      obsClient.call('GetTransitionList').catch(() => ({ transitions: [] })),
      obsClient.call('GetStreamStatus').catch(() => ({ outputActive: false, streaming: false })),
      obsClient.call('GetRecordStatus').catch(() => ({ outputActive: false, recording: false }))
    ]);

    const scenes = Array.isArray(sceneList?.scenes) ? sceneList.scenes.map((scene) => scene.name || scene.sceneName || scene).filter(Boolean) : [];
    const transitions = Array.isArray(transitionList?.transitions) ? transitionList.transitions.map((transition) => transition.name || transition.transitionName || transition).filter(Boolean) : [];
    const currentSceneName = sceneList?.currentProgramSceneName || sceneList?.currentSceneName || state.obs.currentScene;
    const streamActive = !!(streamStatus?.outputActive || streamStatus?.streaming || streamStatus?.isStreaming);
    const recordingActive = !!(recordStatus?.outputActive || recordStatus?.recording || recordStatus?.isRecording);

    state.obs.scenes = scenes;
    state.obs.transitions = transitions;
    state.obs.currentScene = currentSceneName || 'Unknown';
    state.obs.streamState = streamActive ? 'live' : 'offline';
    state.obs.recordingState = recordingActive ? 'recording' : 'off';
    state.obs.currentTransition = transitionList?.currentTransition || state.obs.currentTransition || '';
    broadcastState();
  } catch (error) {
    console.error('OBS refresh error:', error);
    state.obs.lastError = error.message || 'Unable to refresh OBS state';
    broadcastState();
  }
}

async function connectObs(config = {}) {
  const host = sanitizeText(config.host || process.env.OBS_HOST || '', '');
  const port = sanitizeText(config.port || process.env.OBS_PORT || '', '');
  const password = sanitizeText(config.password || process.env.OBS_PASSWORD || '', '');
  const previewUrl = sanitizeText(config.previewUrl || process.env.OBS_PREVIEW_URL || '', '');

  if (!host || !port) {
    state.obs.connected = false;
    state.obs.lastError = 'OBS host and port are required';
    addActivity('OBS configuration incomplete', 'Host and port are required.');
    broadcastState();
    return { connected: false, error: 'OBS host and port are required' };
  }

  state.obs.host = host;
  state.obs.port = port;
  state.obs.password = password;
  state.obs.previewUrl = previewUrl;

  try {
    if (obsClient && obsClient.connected) {
      await obsClient.disconnect();
    }

    obsClient = new OBSWebSocket();
    obsClient.on('ConnectionOpened', () => {
      state.obs.connected = true;
      state.obs.connectedAt = new Date().toISOString();
      state.obs.lastError = '';
      addActivity('OBS connected', `Connected to ${host}:${port}`);
      broadcastState();
    });

    obsClient.on('ConnectionClosed', () => {
      state.obs.connected = false;
      state.obs.lastError = 'OBS connection closed';
      addActivity('OBS disconnected', 'The server lost the OBS WebSocket connection.');
      broadcastState();
    });

    obsClient.on('error', (error) => {
      state.obs.connected = false;
      state.obs.lastError = error?.message || 'OBS error';
      addActivity('OBS error', state.obs.lastError);
      broadcastState();
    });

    obsClient.on('CurrentProgramSceneChanged', async (event) => {
      if (event?.sceneName) {
        state.obs.currentScene = event.sceneName;
        addActivity('OBS scene changed', event.sceneName);
        broadcastState();
      }
    });

    obsClient.on('StreamStateChanged', async (event) => {
      const liveState = event?.outputActive || event?.streaming || event?.state === 'OBS_WEBSOCKET_OUTPUT_STARTED' ? 'live' : 'offline';
      state.obs.streamState = liveState;
      addActivity('Stream state changed', liveState);
      broadcastState();
    });

    obsClient.on('RecordStateChanged', async (event) => {
      const recordState = event?.outputActive || event?.recording || event?.state === 'OBS_WEBSOCKET_OUTPUT_STARTED' ? 'recording' : 'off';
      state.obs.recordingState = recordState;
      addActivity('Recording state changed', recordState);
      broadcastState();
    });

    obsClient.on('SceneListChanged', async () => {
      await updateObsState();
    });

    await obsClient.connect(`ws://${host}:${port}`, password || undefined);
    await updateObsState();
    return { connected: true, message: 'OBS connected successfully' };
  } catch (error) {
    state.obs.connected = false;
    state.obs.lastError = error?.message || 'Connection failed';
    addActivity('OBS connection failed', state.obs.lastError);
    broadcastState();
    return { connected: false, error: state.obs.lastError };
  }
}

async function takeObsScene(sceneName, options = {}) {
  if (!obsClient || !state.obs.connected || !sceneName) {
    return { ok: false, message: 'OBS is not connected or no scene was selected.' };
  }

  try {
    const transitionName = sanitizeText(state.obs.currentTransition || '', '');
    if (transitionName) {
      await obsClient.call('SetCurrentTransition', { transitionName });
      await obsClient.call('TransitionToProgram');
    }

    await obsClient.call('SetCurrentScene', { sceneName });
    state.obs.currentScene = sceneName;
    if (!options.silent) {
      addActivity('Camera taken to program', sceneName);
    }
    broadcastState();
    return { ok: true, message: `Program scene changed to ${sceneName}` };
  } catch (error) {
    state.obs.lastError = error.message || 'Could not switch the scene in OBS';
    addActivity('OBS scene request failed', state.obs.lastError);
    broadcastState();
    return { ok: false, message: state.obs.lastError };
  }
}

async function startStream() {
  if (!obsClient || !state.obs.connected) {
    return { ok: false, message: 'OBS is not connected.' };
  }

  try {
    await obsClient.call('StartStream');
    state.obs.streamState = 'live';
    addActivity('Stream started', 'OBS confirmed the stream started.');
    broadcastState();
    return { ok: true, message: 'Stream started.' };
  } catch (error) {
    state.obs.lastError = error.message || 'Could not start the stream';
    addActivity('Stream start failed', state.obs.lastError);
    broadcastState();
    return { ok: false, message: state.obs.lastError };
  }
}

async function stopStream() {
  if (!obsClient || !state.obs.connected) {
    return { ok: false, message: 'OBS is not connected.' };
  }

  try {
    await obsClient.call('StopStream');
    state.obs.streamState = 'offline';
    addActivity('Stream stopped', 'OBS confirmed the stream stopped.');
    broadcastState();
    return { ok: true, message: 'Stream stopped.' };
  } catch (error) {
    state.obs.lastError = error.message || 'Could not stop the stream';
    addActivity('Stream stop failed', state.obs.lastError);
    broadcastState();
    return { ok: false, message: state.obs.lastError };
  }
}

async function startRecording() {
  if (!obsClient || !state.obs.connected) {
    return { ok: false, message: 'OBS is not connected.' };
  }

  try {
    await obsClient.call('StartRecord');
    state.obs.recordingState = 'recording';
    addActivity('Recording started', 'OBS confirmed recording started.');
    broadcastState();
    return { ok: true, message: 'Recording started.' };
  } catch (error) {
    state.obs.lastError = error.message || 'Could not start recording';
    addActivity('Recording start failed', state.obs.lastError);
    broadcastState();
    return { ok: false, message: state.obs.lastError };
  }
}

async function stopRecording() {
  if (!obsClient || !state.obs.connected) {
    return { ok: false, message: 'OBS is not connected.' };
  }

  try {
    await obsClient.call('StopRecord');
    state.obs.recordingState = 'off';
    addActivity('Recording stopped', 'OBS confirmed recording stopped.');
    broadcastState();
    return { ok: true, message: 'Recording stopped.' };
  } catch (error) {
    state.obs.lastError = error.message || 'Could not stop recording';
    addActivity('Recording stop failed', state.obs.lastError);
    broadcastState();
    return { ok: false, message: state.obs.lastError };
  }
}

function ensureUserPayload(payload = {}) {
  const name = sanitizeText(payload.name || '', '');
  const department = sanitizeText(payload.department || '', '');

  if (!name) {
    throw new Error('A name is required');
  }

  if (!DEPARTMENTS.includes(department)) {
    throw new Error('Department is invalid');
  }

  return { name, department };
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/director.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'director.html'));
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

app.post('/api/obs/connect', async (req, res) => {
  const result = await connectObs(req.body || {});
  if (result.connected) {
    return res.json({ success: true, message: 'OBS connection successful.' });
  }
  return res.status(400).json({ success: false, message: result.error || 'Unable to connect to OBS.' });
});

io.on('connection', (socket) => {
  socket.emit('state:update', getStatePayload());

  socket.on('join:team', (payload) => {
    try {
      const userPayload = ensureUserPayload(payload);
      const existingIndex = state.users.findIndex((user) => user.socketId === socket.id);
      const user = {
        socketId: socket.id,
        name: userPayload.name,
        department: userPayload.department,
        connected: true,
        joinedAt: new Date().toISOString()
      };

      if (existingIndex >= 0) {
        state.users[existingIndex] = user;
      } else {
        state.users.push(user);
      }

      addActivity('User joined', `${user.name} (${user.department}) joined the production team.`);
      broadcastState();
      socket.emit('team:joined', { success: true, message: 'Welcome to the live production workspace.' });
    } catch (error) {
      socket.emit('error:message', { message: error.message || 'Unable to join the team.' });
    }
  });

  socket.on('disconnect', () => {
    const user = state.users.find((member) => member.socketId === socket.id);
    if (user) {
      const index = state.users.findIndex((member) => member.socketId === socket.id);
      if (index >= 0) {
        state.users.splice(index, 1);
      }
      addActivity('User disconnected', `${user.name} disconnected from the team.`);
      broadcastState();
    }
  });

  socket.on('send:message', (payload) => {
    const sender = state.users.find((member) => member.socketId === socket.id);
    const messageText = sanitizeText(payload?.message || '', '');
    if (!messageText) {
      socket.emit('error:message', { message: 'Message cannot be empty.' });
      return;
    }

    const message = {
      id: Date.now().toString(16),
      sender: sender ? sender.name : 'Unknown',
      department: sender ? sender.department : 'Other',
      message: messageText,
      timestamp: new Date().toISOString()
    };

    state.messages.push(message);
    addActivity('Team message sent', `${message.sender} sent a message to the director.`);
    broadcastState();
  });

  socket.on('send:announcement', (payload) => {
    const text = sanitizeText(payload?.text || '', '');
    if (!text) {
      socket.emit('error:message', { message: 'Announcement cannot be empty.' });
      return;
    }

    state.announcement = {
      id: Date.now().toString(16),
      text,
      timestamp: new Date().toISOString(),
      author: 'Director'
    };
    addActivity('Announcement sent', text);
    broadcastState();
  });

  socket.on('send:instruction', (payload) => {
    const target = sanitizeText(payload?.target || 'Everyone', 'Everyone');
    const text = sanitizeText(payload?.text || '', '');
    if (!text) {
      socket.emit('error:message', { message: 'Instruction cannot be empty.' });
      return;
    }

    const instruction = {
      id: Date.now().toString(16),
      target,
      text,
      createdAt: new Date().toISOString(),
      acknowledgedBy: []
    };

    state.instructions.push(instruction);
    addActivity('Instruction sent', `${target}: ${text}`);
    broadcastState();
  });

  socket.on('send:alert', (payload) => {
    const title = sanitizeText(payload?.title || 'URGENT', 'URGENT');
    const text = sanitizeText(payload?.message || '', '');
    if (!text) {
      socket.emit('error:message', { message: 'Alert message cannot be empty.' });
      return;
    }

    const alert = {
      id: Date.now().toString(16),
      title,
      message: text,
      timestamp: new Date().toISOString()
    };

    state.urgentAlerts.push(alert);
    addActivity('Urgent alert sent', `${title}: ${text}`);
    broadcastState();
  });

  socket.on('acknowledge:instruction', (payload) => {
    const instructionId = sanitizeText(payload?.instructionId || '', '');
    const user = state.users.find((member) => member.socketId === socket.id);
    if (!instructionId || !user) {
      return;
    }

    const instruction = state.instructions.find((item) => item.id === instructionId);
    if (!instruction) return;

    const alreadyAcknowledged = instruction.acknowledgedBy.some((entry) => entry.socketId === socket.id);
    if (!alreadyAcknowledged) {
      instruction.acknowledgedBy.push({
        socketId: socket.id,
        name: user.name,
        department: user.department,
        acknowledgedAt: new Date().toISOString()
      });
      addActivity('Instruction acknowledged', `${user.name} acknowledged: ${instruction.text}`);
      broadcastState();
    }
  });

  socket.on('program:status:set', (payload) => {
    const status = sanitizeText(payload?.status || '', '');
    if (!PROGRAM_STATUSES.includes(status)) {
      socket.emit('error:message', { message: 'Invalid program status selected.' });
      return;
    }

    state.programStatus = status;
    addActivity('Program status changed', status);
    syncProgramSceneToStatus(status);
    broadcastState();
  });

  socket.on('countdown:control', (payload) => {
    const action = sanitizeText(payload?.action || '', '');
    const value = Number(payload?.value || state.countdown.duration || 60);

    if (action === 'set-duration') {
      state.countdown.duration = Math.max(1, value);
      state.countdown.remaining = Math.max(1, value);
      addActivity('Countdown duration updated', `${state.countdown.duration}s`);
      broadcastState();
      return;
    }

    if (action === 'start') {
      state.countdown.running = true;
      state.countdown.startedAt = Date.now();
      state.countdown.startedBy = 'Director';
      addActivity('Countdown started', `${state.countdown.duration}s`);
      broadcastState();
      return;
    }

    if (action === 'pause') {
      state.countdown.running = false;
      state.countdown.remaining = Math.max(0, state.countdown.remaining);
      addActivity('Countdown paused', `${state.countdown.remaining}s remaining`);
      broadcastState();
      return;
    }

    if (action === 'reset') {
      state.countdown.running = false;
      state.countdown.remaining = state.countdown.duration;
      state.countdown.startedAt = null;
      addActivity('Countdown reset', `${state.countdown.duration}s`);
      broadcastState();
    }
  });

  socket.on('obs:config:update', async (payload) => {
    const result = await connectObs(payload || {});
    socket.emit('obs:config:result', result);
  });

  socket.on('obs:scene:take', async (payload) => {
    const sceneName = sanitizeText(payload?.sceneName || '', '');
    const result = await takeObsScene(sceneName, { silent: false });
    socket.emit('obs:scene:result', result);
  });

  socket.on('camera:take', async (payload) => {
    const cameraKey = sanitizeText(payload?.cameraKey || '', 'camera1');
    const mapName = state.obs.cameraMappings[cameraKey];
    if (!mapName) {
      socket.emit('error:message', { message: 'No OBS mapping has been configured for this camera.' });
      return;
    }

    const result = await takeObsScene(mapName, { silent: false });
    socket.emit('camera:result', result);
  });

  socket.on('obs:stream:start', async () => {
    const result = await startStream();
    socket.emit('obs:stream:result', result);
  });

  socket.on('obs:stream:stop', async () => {
    const result = await stopStream();
    socket.emit('obs:stream:result', result);
  });

  socket.on('obs:recording:start', async () => {
    const result = await startRecording();
    socket.emit('obs:recording:result', result);
  });

  socket.on('obs:recording:stop', async () => {
    const result = await stopRecording();
    socket.emit('obs:recording:result', result);
  });

  socket.on('obs:refresh', async () => {
    await updateObsState();
    socket.emit('obs:refresh:result', { connected: state.obs.connected, message: 'OBS state refreshed.' });
  });

  socket.on('settings:camera-map', (payload) => {
    const map = payload || {};
    const newMap = {};
    Object.keys(state.obs.cameraMappings).forEach((cameraKey) => {
      const value = sanitizeText(map[cameraKey] || '', '');
      newMap[cameraKey] = value;
    });
    state.obs.cameraMappings = newMap;
    addActivity('Camera mapping updated', JSON.stringify(newMap));
    broadcastState();
  });

  socket.on('settings:scene-map', (payload) => {
    const values = payload || {};
    const newMap = {};
    Object.keys(state.obs.sceneMappings).forEach((statusKey) => {
      const value = sanitizeText(values[statusKey] || '', '');
      newMap[statusKey] = value;
    });
    state.obs.sceneMappings = newMap;
    addActivity('Program scene mapping updated', JSON.stringify(newMap));
    broadcastState();
  });

  socket.on('settings:auto-scene-switch', (payload) => {
    state.obs.autoSceneSwitch = !!payload?.enabled;
    addActivity('Automatic scene switching', state.obs.autoSceneSwitch ? 'enabled' : 'disabled');
    broadcastState();
  });

  socket.on('settings:transition', (payload) => {
    const transitionName = sanitizeText(payload?.transitionName || '', '');
    state.obs.currentTransition = transitionName;
    addActivity('OBS transition selected', transitionName || 'No transition selected');
    broadcastState();
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`CHURCH LIVE STUDIO server running on http://localhost:${PORT}`);
    if (DIRECTOR_PASSWORD === 'change-me') {
      console.warn('WARNING: DIRECTOR_PASSWORD remains at default value. Update your .env file before deployment.');
    }
  });
}

module.exports = { app, server, io, state, connectObs, takeObsScene, startStream, stopStream, startRecording, stopRecording, updateObsState };
