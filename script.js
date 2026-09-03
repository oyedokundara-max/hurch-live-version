const socket = io();

// UI References
const joinModal = document.getElementById('join-modal');
const joinForm = document.getElementById('join-form');
const clockEl = document.getElementById('live-clock');
const socketBadge = document.getElementById('socket-status');
const progStatusEl = document.getElementById('prog-status');
const obsStatusEl = document.getElementById('obs-status');
const cameraLabel = document.getElementById('camera-label');
const urgentBanner = document.getElementById('urgent-alert-panel');
const urgentText = document.getElementById('urgent-alert-text');
const announcementText = document.getElementById('announcement-text');
const instructionsList = document.getElementById('instructions-list');
const teamRoster = document.getElementById('team-list');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const messageHistory = document.getElementById('message-history');

let userDept = 'Other';

// Live Clock Update
setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString();
}, 1000);

// Join Form Handler
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('user-name').value;
  userDept = document.getElementById('user-dept').value;

  socket.emit('user:join', { name, department: userDept });
  joinModal.style.display = 'none';
});

// Socket State Updates
socket.on('connect', () => {
  socketBadge.textContent = 'ONLINE';
  socketBadge.className = 'badge badge-online';
});

socket.on('disconnect', () => {
  socketBadge.textContent = 'OFFLINE';
  socketBadge.className = 'badge badge-offline';
});

socket.on('state:update', (state) => {
  progStatusEl.textContent = state.programStatus;
  obsStatusEl.textContent = state.obs.connected ? 'Connected' : 'Disconnected';
  obsStatusEl.className = state.obs.connected ? 'text-gold' : 'text-muted';

  cameraLabel.textContent = state.cameraMap[state.liveCamera] || state.liveCamera.toUpperCase();

  // Urgent Alerts
  if (state.urgentAlert) {
    urgentText.textContent = state.urgentAlert.text;
    urgentBanner.style.display = 'block';
  } else {
    urgentBanner.style.display = 'none';
  }

  // Announcements
  announcementText.textContent = state.announcement || 'No active announcement';

  // Render Targeted Instructions
  instructionsList.innerHTML = '';
  state.instructions.forEach(inst => {
    if (inst.department === 'Everyone' || inst.department === userDept) {
      const card = document.createElement('div');
      card.className = 'inst-card';
      const hasAck = inst.acknowledgements.some(a => a.userId === socket.id);
      
      card.innerHTML = `
        <div><strong>[${inst.department}]</strong> ${inst.text} <small>(${inst.time})</small></div>
        ${!hasAck ? `<button onclick="acknowledge(${inst.id})" class="btn btn-gold" style="margin-top:5px;padding:2px 8px;font-size:0.75rem;">Acknowledge</button>` : '<small style="color:#10b981;">✓ Acknowledged</small>'}
      `;
      instructionsList.appendChild(card);
    }
  });

  // Render Roster
  teamRoster.innerHTML = '';
  Object.values(state.connectedUsers).forEach(u => {
    const li = document.createElement('li');
    li.textContent = `${u.name} (${u.department})`;
    teamRoster.appendChild(li);
  });
});

function acknowledge(id) {
  socket.emit('team:acknowledge', id);
}

// Messaging
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (messageInput.value.trim()) {
    socket.emit('team:message', messageInput.value.trim());
    messageInput.value = '';
  }
});