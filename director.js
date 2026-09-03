const socket = io();

const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');
const previewCamLabel = document.getElementById('preview-cam-label');
const programCamLabel = document.getElementById('program-cam-label');
const obsBadge = document.getElementById('obs-badge');
const obsUrlDisplay = document.getElementById('obs-url-display');

// Display OBS Link
obsUrlDisplay.textContent = `${window.location.origin}/obs-output`;

document.getElementById('copy-obs-link').addEventListener('click', () => {
  navigator.clipboard.writeText(`${window.location.origin}/obs-output`);
  alert('OBS Link copied to clipboard!');
});

// Authentication
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('auth-password').value;

  const res = await fetch('/api/director/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });

  const data = await res.json();
  if (data.success) {
    authModal.style.display = 'none';
  } else {
    authError.classList.remove('hidden');
  }
});

// Director Controls
function selectPreview(camKey) {
  socket.emit('director:preview-camera', camKey);
}

document.getElementById('btn-take').addEventListener('click', () => {
  socket.emit('director:take-live');
});

document.getElementById('btn-cut').addEventListener('click', () => {
  const currentPreview = previewCamLabel.textContent.toLowerCase().replace(' ', '');
  socket.emit('director:cut-live', currentPreview || 'camera1');
});

document.getElementById('btn-update-status').addEventListener('click', () => {
  const val = document.getElementById('status-select').value;
  socket.emit('director:set-status', val);
});

// Urgent & Announcement
document.getElementById('urgent-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = document.getElementById('urgent-input').value;
  socket.emit('director:urgent-alert', text);
  document.getElementById('urgent-input').value = '';
});

document.getElementById('btn-clear-alert').addEventListener('click', () => {
  socket.emit('director:urgent-alert', '');
});

document.getElementById('announcement-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = document.getElementById('announcement-input').value;
  socket.emit('director:announcement', text);
  document.getElementById('announcement-input').value = '';
});

// Instruction
document.getElementById('instruction-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const department = document.getElementById('inst-dept').value;
  const text = document.getElementById('inst-text').value;
  socket.emit('director:instruction', { department, text });
  document.getElementById('inst-text').value = '';
});

// OBS Config
document.getElementById('obs-config-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = document.getElementById('obs-url').value;
  const password = document.getElementById('obs-pass').value;
  socket.emit('obs:config', { url, password });
});

// State Sync
socket.on('state:update', (state) => {
  previewCamLabel.textContent = state.cameraMap[state.previewCamera] || state.previewCamera.toUpperCase();
  programCamLabel.textContent = state.cameraMap[state.liveCamera] || state.liveCamera.toUpperCase();

  obsBadge.textContent = state.obs.connected ? 'OBS CONNECTED' : 'OBS OFFLINE';
  obsBadge.className = state.obs.connected ? 'badge badge-online' : 'badge badge-offline';
});

socket.on('activity:new', (entry) => {
  const log = document.getElementById('activity-log');
  const div = document.createElement('div');
  div.textContent = `[${entry.time}] ${entry.text}`;
  log.prepend(div);
});