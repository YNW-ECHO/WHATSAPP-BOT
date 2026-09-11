# WhatsApp AI Bot — Full Architecture (Updated)

This document consolidates the original architecture plus everything added since: chat-history style learning, voice-note reply matching, and the web dashboard.

---

## 1. Overview

A personal WhatsApp automation bot that:
- Connects to your WhatsApp account via an unofficial library (Baileys) — same mechanism as WhatsApp Web
- Auto-views contacts' statuses
- Auto-replies to incoming messages using AI, understanding Swahili, English, and code-switching between them
- Learns to write in your own voice/style from your real chat history, aiming for replies indistinguishable from you
- Matches reply format to input format: text in → text out, voice note in → voice note out (via TTS, optionally your cloned voice)
- Accepts voice-note commands from you to send messages to contacts on your behalf
- Is managed through a web dashboard (not inside WhatsApp itself, which doesn't support custom UI)

---

## 2. High-Level Diagram

```
                        ┌─────────────────────────┐
                        │   Your WhatsApp Account   │
                        │  (linked via QR code)     │
                        └────────────┬─────────────┘
                                     │
                          WhatsApp Web Protocol
                                     │
                        ┌────────────▼─────────────┐
                        │   Baileys Client (Node.js) │
                        │  - session/auth storage    │
                        │  - event listeners         │
                        └──┬───────────┬────────────┘
                           │           │
             ┌─────────────┘           └─────────────┐
             ▼                                        ▼
  ┌─────────────────────┐                 ┌───────────────────────┐
  │  Status Watcher       │                 │  Message Router        │
  │  - auto marks status  │                 │  - text vs voice note  │
  │    as read             │                 │  - from you (command)  │
  └───────────────────────┘                 │    vs. from a contact  │
                                             └──────┬─────────┬──────┘
                                                    │         │
                                     Contact msg    │         │  Your voice note (command)
                                       (text/voice) │         │
                                                    ▼         ▼
                          ┌──────────────────────────┐ ┌────────────────────────┐
                          │  AI Reply Engine           │ │  Voice Command Engine   │
                          │  - lang detect (SW/EN)     │ │  - Whisper STT          │
                          │  - style engine (your voice│ │  - intent extraction    │
                          │    from chat history)      │ │  - contact resolver     │
                          │  - context/history per chat│ │    (fuzzy match)        │
                          │  - Claude/GPT call          │ │  - confirmation step    │
                          └──────────┬─────────────────┘ └───────────┬────────────┘
                                     │                                │
                        ┌────────────┴────────────┐                  │
                        ▼                          ▼                  │
             ┌────────────────────┐    ┌───────────────────────┐     │
             │ Text reply           │    │ Voice reply             │     │
             │ (if input was text)  │    │ (if input was voice)    │     │
             │                       │    │ - TTS (ElevenLabs/     │     │
             │                       │    │   OpenAI/Google)        │     │
             │                       │    │ - optional voice clone  │     │
             │                       │    │ - ffmpeg → .ogg/opus    │     │
             └──────────┬────────────┘    └───────────┬─────────────┘     │
                        │                              │                  │
                        └──────────────┬───────────────┘                  │
                                       ▼                                  ▼
                          ┌─────────────────────────────────────────────────┐
                          │              Baileys Send Layer                  │
                          │   sendMessage (text / ptt voice note) to JID     │
                          └───────────────────────┬───────────────────────────┘
                                                  ▼
                          ┌─────────────────────────────────────────────────┐
                          │                Storage (SQLite)                  │
                          │  - chat history & context per contact            │
                          │  - contact list cache                            │
                          │  - per-chat settings (auto-reply, mode, tone)    │
                          │  - voice command logs                            │
                          │  - your message samples (for style learning)     │
                          └───────────────────────┬───────────────────────────┘
                                                  ▼
                          ┌─────────────────────────────────────────────────┐
                          │           Express API + Web Dashboard            │
                          │   (separate browser page, not inside WhatsApp)   │
                          └─────────────────────────────────────────────────┘
```

---

## 3. Components

### 3.1 Baileys Client (core connector)
- Handles auth (QR code or pairing code, scanned once; session persisted to disk)
- Emits events for messages, statuses, connection state, contact sync
- Exposes send functions for text and voice (`ptt`) messages

### 3.2 Status Watcher
- Subscribes to status broadcast events, auto-marks as read
- Optional randomized delay so it doesn't look instant/robotic

### 3.3 Message Router
- Distinguishes: message from you (possible voice command) vs. from a contact (needs a reply)
- Distinguishes: text vs. voice note, so the reply format can match
- Applies filters: allow-listed chats only, groups excluded by default, per-contact rate limits

### 3.4 AI Reply Engine
- Detects language automatically (Swahili/English/mixed) — no separate detector needed, handled by the LLM
- Pulls relevant chat history/context per contact from storage
- **Style engine**: injects examples of your real writing (few-shot) or uses a fine-tuned model, so replies match your tone, phrasing, slang, and language-mixing habits
- Generates the reply text
- Hands off to either the text-send path or the voice-synthesis path, depending on what the incoming message type was

### 3.5 Style Learning (from your chat history)
- **Source data**: exported WhatsApp chats (yours only, filtered from the other party's lines) or live history synced via Baileys
- **Approach A — few-shot (default, low effort)**: ~30–50 diverse examples of your real messages embedded in the system prompt, instructing the model to match sentence length, punctuation, slang, and language-switching
- **Approach B — fine-tuning (optional, higher fidelity)**: message pairs (incoming → your real reply) used to fine-tune a model so your style is baked in rather than prompted each time
- **Approach C — RAG for factual accuracy (optional)**: searchable store (embeddings or keyword search) of past chats, so replies can reference real past context, not just tone
- Realism details: randomized reply delay based on message length, "typing…" indicator before sending, occasional multi-message splitting instead of one clean paragraph, deliberately not over-correcting grammar/punctuation

### 3.6 Voice Reply Matching
- If incoming message is a voice note: transcribe with Whisper → generate reply text via the AI Reply Engine → convert to speech via TTS → convert to `.ogg`/Opus with ffmpeg → send as a proper `ptt` voice bubble
- If incoming message is text: reply stays text, no TTS step
- TTS provider options: ElevenLabs (best quality, supports cloning your actual voice), OpenAI TTS (simpler, cheaper), Google Cloud TTS (strong multilingual support, generous free tier)

### 3.7 Voice Command Engine
- Triggered by voice notes sent by you specifically (private command channel)
- Steps: download audio → Whisper transcription → LLM intent extraction (`{contact_name, message}`) → fuzzy-match against synced contacts → send if confident, ask for confirmation if ambiguous → confirm back to you once sent

### 3.8 Storage (SQLite)
- Chat history/context per contact
- Contact list cache (for fuzzy matching)
- Per-chat settings: auto-reply on/off, reply mode (text/voice/off), tone/formality
- Voice command logs (for reviewing misfires)
- Your message samples used for style learning
- Session credentials for Baileys kept separately, treated as sensitive

### 3.9 Web Dashboard (not inside WhatsApp — WhatsApp has no custom-UI support)
Runs as a separate Express API + frontend on the same VPS, reading/writing the same SQLite database.

| Page | Purpose |
|---|---|
| Overview | Bot online/offline status, messages replied today, active chats, health check |
| Conversations | Active chats, last message, per-contact auto-reply toggle, full history view |
| Voice Activity | Log of voice notes sent/received, with playback |
| Contacts | Synced contact list, per-contact tone/reply-mode settings |
| Voice Commands Log | History of your voice commands, transcription, and resulting action |
| Settings | System prompt editor, API key management, rate limits, global pause switch |
| Logs/Errors | Raw logs for debugging |

Access: via browser at the VPS's IP or a domain, protected by a simple password login (single-user, no need for complex auth, but shouldn't be left open to the internet without at least basic protection).

---

## 4. Tech Stack Summary

| Layer | Choice |
|---|---|
| WhatsApp connector | Baileys (Node.js) |
| Runtime | Node.js 18+ |
| AI (replies, intent extraction, style matching) | Claude API or OpenAI API |
| Speech-to-text | OpenAI Whisper API |
| Text-to-speech | ElevenLabs (voice cloning option) / OpenAI TTS / Google Cloud TTS |
| Audio conversion | ffmpeg (to `.ogg`/Opus for proper voice-note bubbles) |
| Storage | SQLite (`better-sqlite3`) |
| Dashboard backend | Node.js + Express, serving API routes off the same SQLite DB |
| Dashboard frontend | React (or simple server-rendered pages) |
| Hosting | VPS — free tier to start (e.g., Oracle Cloud Free Tier), paid tier later if needed |
| Process manager | PM2 (auto-restart on crash/disconnect, survives reboots with `pm2 startup`) |

---

## 5. Data Flow Summary

1. **Incoming text from a contact** → Router → AI Reply Engine (with style engine) → text reply sent
2. **Incoming voice note from a contact** → Router → Whisper transcribe → AI Reply Engine → TTS → ffmpeg → voice note reply sent
3. **Incoming status update** → Status Watcher → marked as read
4. **Your voice note (command)** → Voice Command Engine → Whisper → intent extraction → contact match → message sent → confirmation sent back to you
5. **All activity** → logged to SQLite → visible/manageable via the Web Dashboard

---

## 6. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Account ban (unofficial library) | Human-like delays, avoid instant/blanket replies, don't touch groups initially |
| Session drops / logout | Auto-reconnect logic, persistent auth storage, self-alert if disconnected |
| Wrong contact match on voice command | Confirmation step before sending when match confidence is low |
| AI replying inappropriately in sensitive chats | Per-chat allow-list, auto-reply off by default for new/unrecognized chats |
| Style-learning data includes other people's messages | Filter to your own lines only before feeding to the model; be selective about what's sent to external APIs |
| API costs scaling with volume (chat AI + Whisper + TTS) | Rate-limit auto-replies, cache common responses, monitor usage via dashboard |
| Free-tier VPS resource limits | Start free (e.g., Oracle Free Tier) for development/validation, move to paid VPS once usage grows |
| Dashboard exposed to the internet | Password-protect it at minimum; consider restricting access by IP or putting it behind a VPN if handling sensitive chat data |

---

## 7. Build & Deployment Order (Recommended)

1. Build and test core bot locally (status watcher, message router, basic AI replies) — use a spare number if available
2. Add style learning (few-shot from your real chat exports) and voice-note reply matching
3. Add the voice command engine for sending messages by voice
4. Move to a free-tier VPS (e.g., Oracle Cloud Free Tier), link your real number there, run under PM2
5. Build and deploy the web dashboard alongside the bot on the same VPS
6. Once stable and within your comfort level, consider upgrading to a paid VPS tier if resource needs grow
