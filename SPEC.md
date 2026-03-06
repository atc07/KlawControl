# Klaw Control — Spec v2

## Overview
iOS command center for OpenClaw. Monitor agents, channel health, manage terminal sessions, and talk to your AI assistant via voice — all from your phone, anywhere.

**This is a product for the OpenClaw community**, not a personal tool. Any OpenClaw user can install the server as a skill and download the iOS app.

## Distribution

### Mac (Server) — OpenClaw Skill
The backend runs as an OpenClaw skill, installed via:
```bash
openclaw install klaw-control
```
This adds the Klaw Control server to the user's OpenClaw gateway — no separate process, no separate config. The skill:
- Exposes REST API + WebSocket endpoints on a configurable port (default 7749)
- Reads the user's `openclaw.json` to discover channels, agents, and configuration
- Authenticates via a generated pairing token
- Starts/stops with the gateway

### iPhone — TestFlight
- Distributed via TestFlight (App Store later when ready)
- First launch → onboarding flow:
  1. "Install the Klaw Control skill on your Mac" (instructions + link)
  2. Pair: scan QR code shown by `openclaw klaw-control pair` OR enter server URL manually
  3. Connection test → ✅ Connected
- For remote access: recommend Tailscale (free) with in-app setup guide

### Pairing Flow
```
Mac terminal:
$ openclaw klaw-control pair
🔗 Klaw Control Pairing
   Local:  http://192.168.1.42:7749
   Tailscale: http://100.64.0.2:7749
   Token: kc_a8f3k2m1...

   [QR CODE]

   Scan this QR code in the Klaw Control app, or enter the URL manually.
```
QR code encodes: `klawcontrol://pair?url=http://100.64.0.2:7749&token=kc_a8f3k2m1...`

### Generalization Rules
- **No hardcoded channels or project names** — all discovered from user's OpenClaw config
- **Intent routing** reads the user's channel list + channel topics/descriptions to route voice messages
- **Voice cloning** is per-user (reference clip stored locally on their device)
- **Backend reads `openclaw.json`** for channel names, guild info, configured providers
- **Works with any OpenClaw setup** — Discord, Telegram, Signal, Slack, whatever channels the user has

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
- **Elevated center mic button** in the tab bar — always accessible from any screen
- Tap to activate → **25% pull-down HUD** slides from top of screen
- Dashboard/content stays visible underneath (dimmed + slight blur)
- **Push-to-talk**: hold the mic to speak, release to send
- **Waveform visualization**: animated audio bars synced to speech
- **Transcript bubble**: frosted glass bubble showing live transcription / response text
- **Voice history resets each session** — no persistence across app launches

#### Voice HUD States (25% pull-down overlay)
Each state has a distinct gradient color + waveform behavior:

1. **Listening** (you speaking)
   - Gradient: Blue → Purple (top-down, ~25% height)
   - Waveform: Active, responding to voice input
   - Label: "Listening..."
   - Transcript: Live transcription of your speech
   - Hint: "Release to send"

2. **Processing** (thinking)
   - Gradient: Same blue → purple, slightly dimmed
   - Waveform: Idle/subtle pulse
   - Label: "Thinking..."
   - Transcript: Shows what you said

3. **Arya Speaking** (my response)
   - Gradient: Green → Blue (top-down)
   - Waveform: Active, synced to TTS output
   - Label: "⚡ Arya"
   - Transcript: Response text (e.g. "Done — posted in the underwriting channel.")
   - Hint: "Tap to interrupt"

4. **Arya Asking Question** (clarification needed)
   - Gradient: Purple → Pink (top-down)
   - Waveform: Active
   - Label: "⚡ Arya has a question"
   - Transcript: The question (e.g. "Staging or production?")
   - Hint: "Hold mic to answer"
   - Center mic button changes to ❓ icon

#### Tab Bar
4 tabs + elevated center mic:
- Dashboard (bar chart icon)
- Channels (chat bubble icon)
- **[Center: Elevated mic button]** — larger, filled, primary CTA
- Terminal (>_ icon)
- Settings (gear icon)

No dedicated Voice tab — the mic button + pull-down HUD handles everything.

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

### Backend (OpenClaw Skill on Mac)
- **Packaged as**: OpenClaw skill (`openclaw install klaw-control`)
- **Server**: Express + ws, runs inside the gateway process
- **Auth**: pairing token generated via `openclaw klaw-control pair` (header-based)
- **Channel discovery**: reads `openclaw.json` at startup to enumerate all configured channels
- **Voice endpoint**: `/api/voice/message` — accepts text from phone, returns:
  ```json
  {
    "voice_response": "Done, posted in underwriting",
    "channel_posted": "underwriting-ai-platform",
    "message_id": "1234567890"
  }
  ```
- **OpenClaw integration**: via OpenClaw JS API (internal, since it runs as a skill)
  - Sends voice messages through the gateway's session system
  - Routes detailed responses to channels via the gateway's message API
- **Terminal**: node-pty + WebSocket relay
- **Dynamic routing**: intent routing uses the user's channel list + topics (no hardcoded mappings)

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

## Build Phases

### Phase 1 — Shell + Dashboard (Week 1)
Get the app skeleton running with real data from the backend.
- [ ] Xcode project setup (SwiftUI, iOS 17+, bundle ID `com.atc07.klawcontrol`)
- [ ] Onboarding flow: scan QR code or enter server URL + token manually
- [ ] `klawcontrol://pair` deep link handler for QR pairing
- [ ] Tab bar with 4 tabs + elevated center mic button (non-functional mic for now)
- [ ] Dashboard screen: health pills, stat row, main agent card, sub-agent list
- [ ] Network layer: connect to backend `/api/status`, `/api/agents`
- [ ] Settings screen: server URL + auth token, connection status, re-pair option
- [ ] Auto-refresh polling (5s interval)
- [ ] Design system: colors, typography, card styles matching reference designs
- [ ] Backend: package as OpenClaw skill with `openclaw klaw-control pair` command

### Phase 2 — Channels + Agent Detail (Week 2)
Full monitoring capability.
- [ ] Channels screen: Discord + Telegram cards with platform icons, stats grid, Gateway Health
- [ ] Agent detail view: tap any agent → task, model, session key, recent output log
- [ ] Agent actions: kill sub-agent, steer (send message)
- [ ] Pull-to-refresh on all screens
- [ ] Error states + offline handling

### Phase 3 — Terminal (Week 3)
Remote terminal from your phone.
- [ ] Terminal screen: session tab bar (pill-style), dark terminal body
- [ ] WebSocket PTY relay to backend (`/ws/terminal/:sid`)
- [ ] ANSI color rendering
- [ ] Keyboard input with send button
- [ ] New session + rename + close/swipe-to-kill
- [ ] Multiple concurrent sessions

### Phase 4 — Voice Foundation (Week 4)
On-device speech pipeline.
- [ ] Integrate `qwen3-asr-swift` Swift package (MLX)
- [ ] Qwen3-ASR 0.6B: model download on first launch, progress indicator
- [ ] CosyVoice3 0.5B: model download, voice synthesis
- [ ] Push-to-talk: hold center mic → record → ASR transcription
- [ ] TTS playback of response text
- [ ] Audio session management (AVFoundation)

### Phase 5 — Voice HUD + Dual Response (Week 5)
The magic.
- [ ] 25% pull-down HUD overlay (slides from top, content dimmed/blurred behind)
- [ ] 4 HUD states: Listening (blue gradient), Processing, Speaking (green), Question (purple)
- [ ] Animated waveform bars synced to audio input/output
- [ ] Frosted transcript bubble with live text
- [ ] Backend `/api/voice/message` endpoint: send transcript, receive dual response
- [ ] Dual response: short voice answer spoken back + detailed text posted to proper channel
- [ ] Intent-based channel routing (keywords → Discord channel / Telegram DM)
- [ ] Multi-turn conversation mode (questions one at a time, no turn limit)
- [ ] Message queue for rapid voice input

### Phase 6 — Voice Cloning + Polish (Week 6)
Personalization + ship prep.
- [ ] Voice clone setup in Settings: record/import 10-30s reference clip
- [ ] CosyVoice3 voice cloning from reference audio
- [ ] Voice preview (test cloned voice)
- [ ] Speech speed adjustment
- [ ] Tailscale connectivity guide / setup helper
- [ ] TestFlight build + deploy
- [ ] Bug fixes + performance optimization

### Future (v2+)
- Push notifications (agent failures, channel disconnects)
- Bonjour/mDNS auto-discovery (local network)
- Always-listening wake word ("Hey Arya")
- PersonaPlex on-device (full speech-to-speech, no network needed)
- Siri Shortcuts integration
- Apple Watch companion (quick voice commands)
- Widget for home screen (agent status at a glance)
- Haptic feedback for voice state transitions

## Design Direction
- **Light theme** — iOS-native, clean, modern
- **iOS HIG compliant**: large titles, grouped table views, system colors
- **Colors**: `#F2F2F7` grouped background, white cards, `#007AFF` blue, `#34C759` green, `#FF9500` orange
- **Icons**: SF Symbol-style line icons (no emoji) — bar chart, chat bubble, mic, terminal prompt, gear
- **Typography**: SF Pro (system), SF Mono (terminal)
- **Cards**: White with subtle shadows, no harsh borders. Colorful circular icons per item (orange for main agent, etc.)
- **Status badges**: Pill-shaped — ACTIVE (green), RUNNING (blue), DONE (gray/green)
- **Tab bar**: 4 tabs + elevated center mic button (larger, filled blue circle)
- **Voice HUD**: 25% pull-down from top with gradient overlay, waveform bars, frosted transcript bubble. Content underneath dimmed + blurred.
- **Voice gradients**: Blue/purple = listening, Green = Arya speaking, Purple/pink = Arya asking question
- **Platform icons**: Actual Discord/Telegram logos in channel cards, not emoji
- **Reference designs**: `design-reference/` directory (7 screens from Claude artifact iterations)

## Dependencies
- `qwen3-asr-swift` — ASR + TTS + CosyVoice (Swift Package, MIT)
- No other external iOS dependencies — pure Apple frameworks
- Backend: Express, ws, node-pty (bundled in the OpenClaw skill)

## Resolved Decisions
- Push-to-talk for v1 (always-listening wake word → v2)
- Voice history resets each session (ephemeral)
- No max conversation turns — runs as long as needed
- Mic button: elevated center of tab bar (not floating)
- Voice overlay: 25% pull-down HUD (not full-screen takeover)
- 4 tabs + center mic (no dedicated Voice tab)

## Open Questions
_None currently — spec is ready for build._
