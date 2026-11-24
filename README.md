# J.A.R.V.I.S. (local)

A voice-controlled AI assistant for macOS with an Iron-Man-style HUD. The brain runs locally through [Ollama](https://ollama.com), the interface is a browser app, and a small Node bridge gives it real control over your Mac.

No cloud AI. No accounts. The only network calls are to your own Ollama instance (and, optionally, your browser's built-in speech recognition).

## What it can do

- **Talk to it.** Wake word ("Jarvis"), hold-space push-to-talk, or just type.
- **Conversation** with local memory per session, spoken replies in a dry British accent when available.
- **Control the Mac** through 20 tools:
  - open, quit and list running apps (aliases like "chrome" and "vscode" work)
  - search the web in Safari (Google, DuckDuckGo, Bing, YouTube)
  - open URLs, files and folders
  - read / write / list / search files
  - run shell commands (with an authorization gate)
  - system diagnostics (CPU, memory, disk, battery, uptime)
  - volume control, media playback (Spotify / Apple Music)
  - screenshots, notifications, clipboard read/write, lock screen
- **Live HUD** with an arc reactor, audio visualiser, diagnostics panel and an activity log of every tool call.

## Requirements

- macOS
- Node.js 20+
- Ollama installed and running
- A tool-capable model. `qwen2.5:3b` is what this machine already has; `llama3.1:8b` or larger is noticeably better at tool use.

## Quick start

```bash
# 1. Make sure Ollama is running and you have a model
ollama serve          # if it is not already running
ollama pull qwen2.5:3b

# 2. Install and start
npm install
npm start

# 3. Open the HUD
open http://127.0.0.1:3030
```

Click **INITIALIZE**, allow microphone access, and say *"Jarvis, what's my battery level?"*

## Using it

| Action | How |
| --- | --- |
| Open an app | "Jarvis, open Chrome" — aliases like `chrome`, `vscode`, `whatsapp`, `terminal` work |
| Close an app | "Jarvis, quit Spotify" |
| What's open | "Jarvis, what apps are running?" |
| Search the web | "Jarvis, search Safari for the weather in London" |
| Open a site | "Jarvis, open apple.com in Safari" |
| Wake word | Say "Jarvis …" (works in Chrome / Safari) |
| Push to talk | Hold **Space** and speak |
| Tap to talk | Click the arc reactor (6-second listening window) |
| Type | Use the console at the bottom |
| Authorize a risky action | Say "authorize", press **Y**, or click AUTHORIZE |
| Deny | Say "deny", press **N** / **Esc**, or click DENY |
| Pick a model | Left panel → Neural Core |
| Mute replies | Header → VOICE |

## Permissions

macOS will prompt for these the first time they are needed:

- **Microphone** — granted to your browser (System Settings → Privacy & Security → Microphone).
- **Automation** — when Jarvis controls Music/Spotify or quits an app, macOS asks permission for your terminal/browser to control that app. Allow it; if you deny, quitting falls back to terminating the app process.
- **Screen Recording** — needed for `screencapture` on recent macOS versions. If screenshots come out black, enable your browser under Privacy & Security → Screen Recording.

## Safety model

Giving a language model control of your machine needs guardrails:

- The server binds to `127.0.0.1` only and rejects non-local `Host` headers and cross-origin writes, so a random website cannot drive your Mac through the localhost port.
- Destructive shell commands (`rm`, `sudo`, `dd`, `shutdown`, `chmod`, `launchctl`, piping curl into a shell, …) pause and require explicit spoken or on-screen authorization before running. Overwriting an existing file does the same.
- Every tool result is logged in the Activity panel.

It is still a powerful remote control for your laptop. Do not expose the port to a network, do not run it on a shared account, and read the authorization prompt before approving.

## Configuration

Copy `.env.example` to `.env` to override defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3030` | HUD port |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Default model |

## How it works

```
Browser HUD (HTML/CSS/JS)
  ├─ Web Speech API  → speech-to-text + text-to-speech
  └─ fetch /api/chat → Node bridge (Express)
                         ├─ Ollama /api/chat with tool schemas
                         ├─ tool execution (zsh, osascript, mdfind, …)
                         └─ authorization gate for risky calls
```

When the model requests a tool, the bridge executes it and feeds the result back until the model produces a final spoken answer. If a tool needs authorization, the loop pauses, the HUD asks, and `/api/confirm` resumes it with your decision.

## Troubleshooting

- **"CORE OFFLINE"** — Ollama is not running (`ollama serve`) or the model name is wrong. Check `ollama list`.
- **No voice input** — use Chrome or Safari, allow the microphone, and make sure the page is on `127.0.0.1` or `localhost` (not a LAN IP; mic access requires a secure context).
- **Model ignores tools / replies badly** — 3B models are the minimum. Try `ollama pull llama3.1:8b` and select it in the Neural Core panel.
- **"No media player is running"** — open Spotify or Music first.
- **Browser speech recognition sends audio to the cloud** — Chrome uses Google's speech service and Safari uses Apple's. The LLM and computer control stay local; the transcription step depends on your browser. A fully offline voice pipeline (whisper.cpp) is a natural next step if you want zero network exposure.
