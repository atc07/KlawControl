# Klaw Control — iOS App

## What This Is
SwiftUI iOS app for monitoring and controlling an OpenClaw instance. Connects to the Klaw Control backend server running on the user's Mac.

## Tech Stack
- Swift, SwiftUI, iOS 17+
- URLSession + URLSessionWebSocketTask (no external deps)
- @Observable pattern for state management

## App Structure

### Screens

1. **DashboardView** (TabView tab 1)
   - Agent status cards (main + sub-agents)
   - Channel health indicators (Discord, Telegram)
   - Quick stats row (messages today, active agents)
   - Pull-to-refresh, auto-refresh every 5s

2. **AgentDetailView** (push from dashboard)
   - Full task description, model, elapsed time
   - Recent output/messages
   - Action buttons: Kill, Steer (text input → send message)

3. **ChannelsView** (TabView tab 2)
   - Per-channel cards with connection status, last activity
   - Gateway health summary

4. **TerminalsView** (TabView tab 3)
   - List of active terminal sessions with custom names
   - "New Session" button → creates session, navigates to terminal
   - Swipe to delete/kill sessions
   - Long-press to rename

5. **TerminalView** (push from terminals list)
   - Full-screen terminal emulator
   - WebSocket connection to backend PTY relay
   - ANSI escape code rendering
   - Keyboard input → sent to WebSocket
   - Dark background, monospace font

6. **SettingsView** (TabView tab 4)
   - Server URL (IP:port)
   - Auth token
   - Connection test button

### Project Structure
```
KlawControl/
├── KlawControlApp.swift
├── Models/
│   ├── AgentSession.swift
│   ├── ChannelStatus.swift
│   ├── TerminalSession.swift
│   └── GatewayHealth.swift
├── Services/
│   ├── APIClient.swift          # REST calls
│   ├── WebSocketManager.swift   # Terminal WS
│   └── AppState.swift           # @Observable global state
├── Views/
│   ├── Dashboard/
│   │   ├── DashboardView.swift
│   │   └── AgentCardView.swift
│   ├── Agents/
│   │   └── AgentDetailView.swift
│   ├── Channels/
│   │   └── ChannelsView.swift
│   ├── Terminal/
│   │   ├── TerminalsListView.swift
│   │   ├── TerminalView.swift
│   │   └── ANSIParser.swift
│   └── Settings/
│       └── SettingsView.swift
├── Assets.xcassets/
└── Info.plist
```

## Bundle ID
`com.atc07.klawcontrol`

## Build
Xcode 16+, iOS 17+ target, deploy via TestFlight.

## Design Notes
- Dark mode primary (fits the terminal/hacker aesthetic)
- SF Symbols for icons
- Monospace font for terminal: SF Mono or Menlo
- Accent color: electric blue or green (claw vibes)
