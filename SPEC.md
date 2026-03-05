# Klaw Control — Spec v2

## Overview
iOS command center for OpenClaw. Monitor agents, channel health, manage terminal sessions, and talk to your AI assistant via voice — all from your phone, anywhere.

## Architecture

### System Diagram
```
┌─────────────────────────────────────────────┐
│                 iPhone App                   │
│                                              │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐ │
│  │ Qwen3-ASR│  │CosyVoice3 │  │   App UI │ │
│  │  (0.6B)  │  │  (0.5B)   │  │ SwiftUI  │ │
│  │ STT Local│  │ TTS+Clone │  │          │ │
│  └────┬─────┘  └─────▲─────┘  └────┬─────┘ │
│       │ text          │ text        │        │
│       └───────┬───────┘             │        │
│               │                     │        │
│         ┌─────▼─────┐              │        │
│         │  Voice     │              │        │
│         │  Router    │──────────────┘        │
│         └─────┬──────┘                       │
└───────────────┼──────────────────────────────┘
                │ text (HTTPS/WSS)
                │ ~few KB per message
                │ works on cellular
                │
    ┌───────────▼───────────────────────┐
    │        Mac (Home Server)          │
    │                                    │
    │  ┌─────────────────────────────┐  │
    │  │   Klaw Control Backend      │  │
    │  │   Node.js (Express + WS)    │  │
    │  │                             │  │
    │  │  /api/voice/message  ←──────│──│── text in
    │  │  /api/voice/response ───────│──│── text out
    │  │  /api/status                │  │
    │  │  /api/agents                │  │
    │  │  /api/channels              │  │
    │  │  /ws/terminal/:sid          │  │
    │  └──────────┬──────────────────┘  │
    │             │                      │
    │  ┌──────────▼──────────────────┐  │
    │  │   OpenClaw Gateway          │  │
    │  │   (Claude Opus brain)       │  │
    │  │                             │  │
    │  │  - Processes voice messages │  │
    │  │  - Routes to Discord/TG     │  │
    │  │  - Returns short voice resp │  │
    │  │  - Posts detailed text resp  │  │
    │  └─────────────────────────────┘  │
    └────────────────────────────────────┘
```

### Network
- **Primary**: Tailscale VPN (free, zero-config mesh network)
- iPhone connects to Mac from anywhere via Tailscale IP
- Only **text** crosses the network (~few KB per message)
- Audio processing is 100% on-device (iPhone)
- Works on spotty cellular — text is resilient to bad signal

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
- **New Session** button → spawns a new coding-agent session
- **Rename** — long-press or edit icon to rename any session
- **Multiple tabs** — switch between active terminal sessions
- Full ANSI rendering, input from phone keyboard
- Swipe to kill/close sessions

### 5. Voice (NEW — "Talk to Arya")
The killer feature. A voice interface to OpenClaw that routes intelligently.

#### Voice Mode UI
- **Floating mic button** — accessible from any screen (bottom-right, above tab bar)
- Tap to activate → expands into voice mode overlay
- **Push-to-talk**: hold the button to speak, release to send
- **Visual feedback**: waveform animation while listening, pulsing dot while processing
- **Conversation history**: scrollable list of recent voice exchanges (last 10)
- **Full-screen option**: tap to expand voice mode into dedicated screen

#### Voice Pipeline (On-Device)
```
[Mic Input] → Qwen3-ASR (0.6B, on-device)
                    ↓ text
            [Voice Router]
                    ↓ text (over network)
            [OpenClaw Gateway on Mac]
                    ↓
            ┌───────┴────────┐
            │                │
     Short voice resp   Detailed text resp
     (back to phone)    (posted to proper
                         Discord/TG channel)
            │
            ↓
      CosyVoice3 (0.5B, on-device)
            ↓
      [Speaker Output]
```

#### Dual Response System
Every voice message produces TWO responses:

1. **Voice Response (spoken back to you)**
   - Short, conversational, to-the-point
   - Examples: "Done, posted in underwriting", "Joey's been notified", "Your next meeting is at 3pm"
   - If I have questions, asked one at a time
   - Generated by OpenClaw with a `voice_summary` flag
   - Spoken via CosyVoice3 with cloned voice

2. **Text Response (posted to proper channel)**
   - Full detailed response with context
   - Routed to the correct Discord channel based on intent:
     - SousIQ topic → #sousiq
     - Underwriting/SubMerit → #underwriting-ai-platform
     - Klaw Control → #klaw-control
     - General/personal → Telegram DM
     - No matching channel → #general
   - Includes all details, code snippets, links, etc.

#### Intent Routing Logic
The backend determines where to route based on message content:
```
"update Joey on the login bug" → #underwriting-ai-platform
"what's the SousIQ build status" → #sousiq
"remind me to call the dentist" → Telegram DM
"how's the weather" → voice-only (no text channel needed)
"deploy the frontend" → #underwriting-ai-platform + voice confirmation
```

Routing rules:
- Keywords/project names → mapped to known Discord channels
- People mentioned → route to their project channel
- Personal/calendar/reminders → Telegram DM
- Quick questions (weather, time, math) → voice-only, no text post
- Ambiguous → ask via voice: "Should I post this in underwriting or general?"

#### Voice Cloning
- **Engine**: CosyVoice3 0.5B (Apache 2.0, free)
- **Setup**: Record a 10-30 second reference clip in Settings
- **Storage**: Reference clip stored locally on device
- **Result**: All TTS output uses the cloned voice
- **Default**: If no reference clip, use CosyVoice3 default voice

#### Conversation Mode
When I (OpenClaw) need to ask clarifying questions:
- Questions asked **one at a time** via voice
- Simple, direct phrasing (not paragraph-long)
- Wait for your voice answer before asking next question
- Example flow:
  > Arya: "Which environment — staging or production?"
  > You: "Production"
  > Arya: "Got it. Should I notify Joey first?"
  > You: "Yeah"
  > Arya: "Done. Deployed to production and messaged Joey in underwriting."

#### Message Queue
- Voice messages are queued if sent rapidly
- Each message processed in order
- Status shown in UI: "Processing 1 of 3..."
- If network drops, messages are queued locally and sent when connection resumes

### 6. Settings
- **Server URL** — Mac's Tailscale IP or hostname
- **Auth token** — shared secret
- **Voice Settings**:
  - Voice reference clip (record / import)
  - Voice preview (test the cloned voice)
  - Speech speed adjustment
  - Push-to-talk sensitivity
- **Push notification preferences** (agent failures, channel disconnects)
- **Appearance**: theme, terminal font size

## Tech Stack

### iOS App
- **Language**: Swift, SwiftUI, iOS 17+
- **On-device ML**: MLX framework via `qwen3-asr-swift` Swift package
  - Qwen3-ASR 0.6B (~400MB) — speech-to-text
  - CosyVoice3 0.5B (~500MB) — text-to-speech + voice cloning
- **Networking**: URLSession + URLSessionWebSocketTask
- **Audio**: AVFoundation (capture + playback)
- **State**: @Observable pattern
- **Auto-refresh**: polling every 5s for dashboard, WebSocket for terminal + voice
- **VPN**: Tailscale SDK (optional) or manual Tailscale app

### Backend (Node.js on Mac)
- **Server**: Express + ws
- **Voice endpoint**: `/api/voice/message` — accepts text from phone, returns:
  ```json
  {
    "voice_response": "Done, posted in underwriting",
    "channel_posted": "underwriting-ai-platform",
    "message_id": "1234567890"
  }
  ```
- **OpenClaw integration**: via OpenClaw JS API or CLI
  - `openclaw agent --message "..." --thinking low` for voice (fast, concise)
  - Routes detailed response to proper channel via `openclaw message send`
- **Terminal**: node-pty + WebSocket relay
- **Auth**: shared secret token (header-based)

### ML Models (on-device, downloaded on first launch)
| Model | Size | Purpose | Source |
|-------|------|---------|--------|
| Qwen3-ASR 0.6B (4-bit) | ~400MB | Speech → Text | `qwen3-asr-swift` |
| CosyVoice3 0.5B (4-bit) | ~500MB | Text → Speech + Voice Clone | `qwen3-asr-swift` |

Models downloaded from HuggingFace on first launch. Cached locally.
Total on-device: ~900MB.

## Data Model

```swift
// Existing models (unchanged)
struct AgentSession: Codable, Identifiable {
    let id: String
    let label: String?
    let kind: String        // "main" | "sub-agent" | "cron"
    let status: String      // "active" | "completed" | "failed"
    let task: String?
    let model: String?
    let startedAt: Date
    let lastActivity: Date?
}

struct ChannelStatus: Codable, Identifiable {
    let id: String
    let connected: Bool
    let lastMessageIn: Date?
    let lastMessageOut: Date?
    let details: [String: String]
}

struct GatewayHealth: Codable {
    let status: String
    let uptime: TimeInterval
    let version: String
}

// New voice models
struct VoiceMessage: Codable, Identifiable {
    let id: UUID
    let transcript: String          // what user said (from ASR)
    let voiceResponse: String       // short spoken response
    let channelPosted: String?      // which channel got the detailed response
    let detailedResponse: String?   // full text response (if applicable)
    let timestamp: Date
    let status: VoiceMessageStatus
}

enum VoiceMessageStatus: String, Codable {
    case transcribing   // ASR processing
    case sending        // sending to backend
    case processing     // OpenClaw thinking
    case speaking       // TTS playing response
    case complete
    case failed
}

struct VoiceSettings: Codable {
    var referenceClipURL: URL?      // path to voice clone reference
    var speechSpeed: Float          // 0.5 - 2.0, default 1.0
    var pushToTalkEnabled: Bool     // true = push-to-talk, false = auto-detect
    var voiceResponsesEnabled: Bool // can disable voice, text-only
}
```

## API Endpoints

### Existing
```
GET  /api/status              → gateway health, uptime
GET  /api/agents              → list active sessions + sub-agents
GET  /api/agents/:id          → session detail + recent messages
POST /api/agents/:id/steer    → send message to session
POST /api/agents/:id/kill     → kill sub-agent
GET  /api/channels            → Discord/Telegram connection status
WS   /ws/terminal/:sid        → PTY relay to exec session
```

### New (Voice)
```
POST /api/voice/message       → send voice transcript, get dual response
     Request:  { "transcript": "update Joey on the login bug", "context": "voice" }
     Response: { "voice_response": "Done, posted in underwriting",
                 "channel_posted": "#underwriting-ai-platform",
                 "detailed_response": "...",
                 "message_id": "..." }

GET  /api/voice/channels      → list available routing targets
     Response: { "channels": [
       { "id": "underwriting-ai-platform", "name": "#underwriting-ai-platform", "keywords": ["sdi", "submerit", "joey"] },
       { "id": "sousiq", "name": "#sousiq", "keywords": ["sousiq", "recipe", "meal"] },
       ...
     ]}

POST /api/voice/conversation  → multi-turn voice conversation (when I have questions)
     Request:  { "transcript": "production", "conversation_id": "abc123" }
     Response: { "voice_response": "Got it. Should I notify Joey first?",
                 "needs_reply": true,
                 "conversation_id": "abc123" }
```

## Latency Budget

| Step | Time |
|------|------|
| User speaks (avg sentence) | ~2-4 seconds |
| Qwen3-ASR on-device | ~200ms |
| Text → Mac (cellular/Tailscale) | ~100-200ms |
| OpenClaw processing (Claude API) | ~1-3 seconds |
| Text → Phone | ~100-200ms |
| CosyVoice3 TTS on-device | ~200ms |
| **Total (end of speech → start of audio)** | **~1.5-3.5 seconds** |

## MVP Scope (v1)

### ✅ In Scope
1. Dashboard with agent list + channel status
2. Sub-agent detail + kill/steer
3. Channel health monitoring
4. Terminal relay to coding sessions
5. **Voice mode with on-device ASR + TTS**
6. **Dual response system (voice + text channel)**
7. **Intent-based channel routing**
8. **Voice cloning via CosyVoice3**
9. **Push-to-talk activation**
10. **Message queue for rapid voice input**
11. Light/clean modern UI theme

### ❌ v2 (Later)
- Push notifications (agent failures, channel disconnects)
- Bonjour/mDNS auto-discovery (local network)
- Always-listening wake word ("Hey Arya")
- PersonaPlex on-device (full speech-to-speech, no network)
- Siri Shortcuts integration
- Apple Watch companion (quick voice commands)
- Widget for home screen (agent status at a glance)

## Design Direction
- **Light theme** — clean, modern, minimal
- **Design language**: SF Symbols, system colors, rounded corners
- **Inspiration**: Apple Health app, Shortcuts app, Arc browser
- **Typography**: SF Pro (system), SF Mono (terminal)
- **Voice UI**: inspired by ChatGPT voice mode — minimal, centered, waveform animation

## Distribution
- **TestFlight** for deployment
- App name: **Klaw Control**
- Bundle ID: `com.atc07.klawcontrol`

## Dependencies
- `qwen3-asr-swift` — ASR + TTS + CosyVoice (Swift Package, MIT)
- No other external dependencies — pure Apple frameworks

## Open Questions
1. ~~Push-to-talk vs always-listening~~ → Push-to-talk for v1
2. Should voice history persist across app launches or be ephemeral?
3. Max conversation turns before auto-ending a multi-question flow?
4. Should the floating mic button be customizable (position, size)?
