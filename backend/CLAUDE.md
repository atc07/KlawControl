# Klaw Control — Backend Server

## What This Is
A lightweight Node.js HTTP + WebSocket server that runs alongside OpenClaw on macOS. It exposes OpenClaw state to the Klaw Control iOS app.

## Tech Stack
- Node.js 20+, Express, ws (WebSocket), node-pty
- No database — everything is live state from OpenClaw CLI

## API Endpoints

```
GET  /api/status           → { status, uptime, version }
GET  /api/agents            → [{ id, label, kind, status, task, model, startedAt, lastActivity }]
GET  /api/agents/:id        → { ...agent, recentMessages: [...] }
POST /api/agents/:id/steer  → { message } → send message to session
POST /api/agents/:id/kill   → kill sub-agent
GET  /api/channels           → [{ id, connected, lastMessageIn, lastMessageOut, details }]
GET  /api/terminals          → [{ sid, name, pid, startedAt }]
POST /api/terminals          → { name? } → spawn new PTY session, returns { sid }
PATCH /api/terminals/:sid    → { name } → rename session
DELETE /api/terminals/:sid   → kill terminal session
WS   /api/terminals/:sid/ws  → bidirectional PTY relay
```

## Auth
- Header: `Authorization: Bearer <token>`
- Token set via `KLAW_AUTH_TOKEN` env var

## How It Gets Data
- `openclaw channels status` → parse for channel health
- `openclaw health` → gateway status
- OpenClaw sessions_list / sessions_history → agent data (via openclaw CLI or direct API)
- node-pty → spawn and relay terminal sessions

## Build & Run
```bash
npm install
KLAW_AUTH_TOKEN=your-secret node server.js
```

## Project Structure
```
backend/
├── server.js          # Express + WS setup, routes
├── lib/
│   ├── openclaw.js    # OpenClaw CLI wrappers
│   ├── terminals.js   # PTY session manager
│   └── auth.js        # Auth middleware
├── package.json
└── CLAUDE.md
```
