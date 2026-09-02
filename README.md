# CHURCH LIVE STUDIO

CHURCH LIVE STUDIO is a professional church live-production control platform for coordinating a church technical/media team and managing the live production workflow connected to OBS Studio.

## Features

- Team join flow with name and department selection
- Real-time production status updates with Socket.IO
- Director dashboard protected by server-side password validation
- Countdown synchronization across connected clients
- Announcements, instructions, acknowledgements, and urgent alerts
- Team messaging to the director
- OBS connection management with server-side integration
- Four-camera workflow with configurable camera mappings
- Program and preview scene workflow tied to OBS where supported
- Stream and recording controls based on actual OBS state
- Activity log and system status monitoring
- Responsive dark broadcast-style interface

## Requirements

- Node.js 18+
- npm
- OBS Studio with WebSocket enabled
- Network access from the server to OBS when hosted locally or remotely

## Installation

```bash
npm install
```

## Start the app

```bash
npm start
```

The app listens on `process.env.PORT || 3000`.

## Environment variables

Create or edit the `.env` file in the project root.

```env
PORT=3000
DIRECTOR_PASSWORD=your-secure-password
OBS_HOST=127.0.0.1
OBS_PORT=4455
OBS_PASSWORD=
OBS_PREVIEW_URL=
```

### Variables

- `PORT`: HTTP port for the app
- `DIRECTOR_PASSWORD`: password required to access the director dashboard
- `OBS_HOST`: IP or hostname of the OBS Studio WebSocket server
- `OBS_PORT`: OBS WebSocket port (default 4455)
- `OBS_PASSWORD`: OBS WebSocket password if configured
- `OBS_PREVIEW_URL`: optional browser-compatible preview source or OBS browser source URL

## Director password configuration

Set a secure `DIRECTOR_PASSWORD` in `.env` before running the app. The password is validated on the server only and is never exposed to regular users.

## OBS WebSocket setup

1. Open OBS Studio.
2. Go to Tools > WebSocket Server Settings.
3. Enable WebSocket server.
4. Set the port and optional password.
5. Ensure the server running CHURCH LIVE STUDIO can reach the OBS machine over the network.

## OBS connection setup

From the director dashboard, open the OBS controls and configure:

- OBS host
- OBS port
- OBS password

Then connect. If the details are valid, the app retrieves scenes, transitions, stream status, recording status, and current scene from OBS.

## Camera / source mapping

The director can map Camera 1-4 to actual OBS scenes or sources from the connected OBS workspace. The mapping is editable in the director panel and allows fast preview/take control during the service.

## Local usage

1. Install dependencies with `npm install`.
2. Start the server with `npm start`.
3. Open the main team page in the browser at `http://localhost:3000`.
4. Open the director page at `http://localhost:3000/director.html`.
5. Log in with the configured `DIRECTOR_PASSWORD`.

## GitHub setup

- Initialize a repository with `git init` if needed.
- Add the project files.
- Commit and push to GitHub.
- Keep `.env` local and ignored from Git using `.gitignore`.

## Render deployment

This project is prepared for deployment to Render.

Recommended environment variables in Render:

```env
PORT=10000
DIRECTOR_PASSWORD=your-password
OBS_HOST=your-obs-host-or-private-address
OBS_PORT=4455
OBS_PASSWORD=your-obs-password
```

Important: a public Render instance cannot typically reach an OBS instance running on a private church LAN unless a secure bridge, tunnel, or local proxy is in place. If OBS is installed on a local production machine, configure network access carefully.

## Important network requirements

OBS is often run on a local production workstation while the web app is hosted elsewhere. The app does not assume that a remote server can automatically reach a private LAN OBS installation.

For reliable remote control, use one of the following:

- a VPN or private network route
- a local bridge service running on the church network
- a reverse proxy or tunnel that exposes the OBS WebSocket securely
- a local host deployment where the app and OBS are on the same network

The app reports actual status and does not claim OBS is connected unless the server can successfully communicate with it.

## Troubleshooting

- If the director dashboard cannot log in, verify `DIRECTOR_PASSWORD` in `.env` and the cookie is allowed by the browser.
- If OBS is disconnected, verify the `OBS_HOST`, `OBS_PORT`, and `OBS_PASSWORD` values.
- If scenes are missing, ensure OBS WebSocket is enabled and the server can reach the OBS machine.
- If the stream or recording state does not appear, verify the OBS session is active and the correct WebSocket namespace is running.
- If the app refuses empty messages, ensure the message is not blank after trimming whitespace.

## Security notes

- No password is hardcoded in frontend JavaScript.
- Director authentication is validated on the server side.
- OBS credentials are kept in `.env` and not exposed to regular users.
- Incoming data is sanitized and validated before acting on it.
