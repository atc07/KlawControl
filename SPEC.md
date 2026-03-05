# Klaw Control — Spec v1

## Overview
iOS app that serves as a real-time command center for your OpenClaw instance. Monitor agents, channel health, and remotely control coding sessions — all from your phone.

## Core Screens

### 1. Dashboard (Home)
- **Agent Status** — main agent session: model, uptime, last activity
- **Sub-Agents** — live list of active sub-agents with: label, task summary, status (running/completed/failed), elapsed time
- **Channel Health** — Discord & Telegram connection status (connected/disconnected, last message in/out timestamps)
- **Quick Stats** — messages today, sub-agents spawned, token usage if available

### 2. Agent Detail
- Tap any agent/sub-agent → see full task description, recent output, elapsed time
- Actions: kill sub-agent, steer (send message), view full log

### 3. Channels
- Discord: per-channel status (last activity, message counts)
- Telegram: connection status, last activity
- Gateway health: `openclaw health` equivalent

### 4. Terminal
- **Sessions List** — shows all active terminal sessions with custom names
- Tap a session → full-screen terminal view (WebSocket PTY relay)
- **New Session** button → spawns a new coding-agent session, drops you straight into the terminal
- **Rename** — long-press or edit icon to rename any session
- **Multiple tabs** — switch between active terminal sessions without losing state
- Full ANSI rendering, input from phone keyboard
- Swipe to kill/close sessions

### 5. Settings
- Server URL configuration (your Mac's IP/hostname)
- Auth token
- Push notification preferences (agent failures, channel disconnects)

## Architecture

### Backend (runs on your Mac)
A lightweight HTTP + WebSocket server that exposes OpenClaw state:

```
GET  /api/status          → gateway health, uptime
GET  /api/agents           → list active sessions + sub-agents
GET  /api/agents/:id       → session detail + recent messages
POST /api/agents/:id/steer → send message to session
POST /api/agents/:id/kill  → kill sub-agent
GET  /api/channels         → Discord/Telegram connection status
WS   /api/terminal/:sid    → PTY relay to a coding-agent exec session
```

**Implementation:** Node.js (Express + ws). Talks to OpenClaw via:
- `openclaw channels status` (parsed)
- `openclaw health` (parsed)
- Sessions list/history via the OpenClaw JS API or CLI
- PTY relay via node-pty for terminal sessions

### iOS App (Swift + SwiftUI)
- **Networking:** URLSession + URLSessionWebSocketTask (native, no deps)
- **State:** @Observable pattern (iOS 17+)
- **Terminal:** Custom terminal view rendering ANSI escape codes
- **Auto-refresh:** polling every 5s for dashboard, WebSocket for terminal
- **Local network discovery:** Bonjour/mDNS to find the server automatically

## Tech Stack
- **iOS:** Swift, SwiftUI, iOS 17+
- **Backend:** Node.js 20+, Express, ws, node-pty
- **Auth:** Simple shared secret token (header-based)
- **No external dependencies on iOS side** — pure Apple frameworks

## Data Model

```swift
struct AgentSession: Codable, Identifiable {
    let id: String           // session key
    let label: String?
    let kind: String         // "main" | "sub-agent" | "cron"
    let status: String       // "active" | "completed" | "failed"
    let task: String?
    let model: String?
    let startedAt: Date
    let lastActivity: Date?
}

struct ChannelStatus: Codable, Identifiable {
    let id: String           // "discord" | "telegram"
    let connected: Bool
    let lastMessageIn: Date?
    let lastMessageOut: Date?
    let details: [String: String]  // per-channel info
}

struct GatewayHealth: Codable {
    let status: String       // "ok" | "degraded" | "down"
    let uptime: TimeInterval
    let version: String
}
```

## MVP Scope (v1)
1. ✅ Dashboard with agent list + channel status
2. ✅ Sub-agent detail + kill/steer
3. ✅ Channel health monitoring
4. ✅ Terminal relay to coding sessions
5. ❌ Push notifications (v2)
6. ❌ Bonjour discovery (v2 — manual IP for now)

## Distribution
- **TestFlight** for deployment
- App name: **Klaw Control**
- Bundle ID: `com.atc07.klawcontrol`

## Decisions
- Multiple simultaneous terminal sessions with tabs
- Sessions are renamable
- New session button drops you straight into terminal
