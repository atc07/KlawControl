# CLAUDE.md — Klaw Control iOS App

## Project
Klaw Control — iOS command center for OpenClaw. Native Swift + SwiftUI.

## Build
```bash
cd KlawControl
xcodebuild -project KlawControl.xcodeproj -scheme KlawControl -destination 'platform=iOS Simulator,name=iPhone 16 Pro' build
```

## Structure
```
KlawControl/
├── KlawControlApp.swift          # App entry, tab bar setup
├── Models/
│   ├── AgentSession.swift        # Agent/sub-agent data
│   ├── ChannelStatus.swift       # Channel connection info
│   ├── GatewayHealth.swift       # Gateway health data
│   └── TerminalSession.swift     # Terminal session data
├── Services/
│   ├── APIClient.swift           # REST API networking
│   ├── AppState.swift            # @Observable app state
│   └── WebSocketManager.swift    # WebSocket for terminal
├── Views/
│   ├── Dashboard/
│   │   ├── DashboardView.swift   # Main dashboard screen
│   │   └── AgentCardView.swift   # Agent row component
│   ├── Channels/
│   │   └── ChannelsView.swift    # Channel status screen
│   ├── Agents/
│   │   └── AgentDetailView.swift # Agent drill-in detail
│   ├── Terminal/
│   │   ├── TerminalsListView.swift
│   │   └── TerminalView.swift    # WebSocket PTY terminal
│   └── Settings/
│       └── SettingsView.swift    # Server URL, auth, prefs
└── Assets.xcassets/
```

## Phase 1 Task — Shell + Dashboard
Rebuild the app from the existing scaffold to match the new design spec.

### Design Requirements (CRITICAL — follow these exactly)
- **Light theme, iOS-native**: `#F2F2F7` grouped background, white cards with subtle shadows
- **Large title navigation** per iOS HIG
- **SF Symbols line icons** — no emoji anywhere
- **Tab bar**: 4 tabs + elevated center mic button
  - Tab 1: Dashboard (chart.bar icon)
  - Tab 2: Channels (bubble.left.and.bubble.right icon)
  - Center: Elevated mic button (mic.fill, larger, filled blue circle `#007AFF`)
  - Tab 3: Terminal (terminal icon)
  - Tab 4: Settings (gearshape icon)
- **iOS system colors**: `#007AFF` blue, `#34C759` green, `#FF9500` orange, `#FF3B30` red
- **Status badges**: Pill-shaped — ACTIVE (green bg), RUNNING (blue bg), DONE (gray bg)
- **Agent icons**: Colored circles (40x40) with SF Symbols inside:
  - Main agent: orange circle with `brain` icon
  - Sub-agents: varied colors (blue=gear, purple=magnifyingglass, green=checkmark)
- **Cards**: White background, cornerRadius(16), shadow(color: .black.opacity(0.04), radius: 8, y: 2)
- **Health pills**: Row of rounded pills at top of dashboard (Gateway ● , Discord ● , Telegram ●)
  - Green dot + text for connected, orange for warning, red for disconnected
- **Stat row**: 3 boxes (Messages, Agents, Tokens) with large blue numbers
- **Chevron disclosure** on main agent card (tappable → agent detail)

### Screens to Build
1. **Onboarding** — First launch: enter server URL + auth token, or scan QR code
   - Deep link handler for `klawcontrol://pair?url=...&token=...`
   - Connection test button → shows ✅ Connected or ❌ error
2. **Dashboard** — Health pills, stats, main agent card, sub-agent list
3. **Channels** — Discord + Telegram cards with platform SF Symbols, 2x2 stats grid, Gateway Health section
4. **Terminal** — Session tabs (pills), dark terminal view, command input (placeholder for Phase 3 WebSocket)
5. **Settings** — Connection section, Voice section (placeholder), Notifications toggles, About

### Architecture
- `@Observable` pattern for state management
- `APIClient` with async/await for networking
- Auto-refresh: Timer-based polling every 5 seconds
- Keychain storage for auth token
- UserDefaults for server URL and preferences

### API Endpoints (mock data OK for now, real endpoints later)
```
GET /api/status    → GatewayHealth
GET /api/agents    → [AgentSession]
GET /api/channels  → [ChannelStatus]
```

### What NOT to do
- No emoji in the UI — SF Symbols only
- No hardcoded channel names or project-specific data
- Don't implement voice features yet (Phase 4-5)
- Don't implement WebSocket terminal yet (Phase 3) — just the UI shell
- Don't use any third-party dependencies

### Design Reference
See `../design-reference/` for 7 reference screenshots showing the target design.
Read the images in that directory to understand the visual direction.

## Git
- Commit directly to `main`
- Commit frequently
