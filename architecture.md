# WhatsApp AI Bot — Architecture

## 1. Overview

A personal WhatsApp automation bot that:
- Connects to your WhatsApp account (unofficial web protocol, not the paid Business API)
- Auto-views contacts' statuses
- Auto-replies to incoming messages using AI, understanding both Swahili and English
- Accepts voice-note commands from you and sends messages to contacts on your behalf

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
  │  - listens for status │                 │  - detects: normal msg │
  │    updates            │                 │    vs. voice command   │
  │  - auto marks as read │                 │    (from your own JID) │
  └───────────────────────┘                 └──────┬─────────┬──────┘
                                                    │         │
                                       Normal msg   │         │  Voice note from YOU
                                                    ▼         ▼
                                     ┌───────────────────┐ ┌────────────────────────┐
                                     │  AI Reply Engine    │ │  Voice Command Engine   │
                                     │  - lang detect      │ │  - Whisper STT          │
                                     │    (SW/EN)          │ │  - intent extraction    │
                                     │  - context/history   │ │  - contact resolver     │
                                     │  - Claude/GPT call   │ │    (fuzzy match)        │
                                     └──────────┬──────────┘ └───────────┬────────────┘
                                                │                        │
                                                ▼                        ▼
                                     ┌─────────────────────────────────────┐
                                     │        Baileys Send Layer            │
                                     │  (sendMessage to resolved JID)       │
                                     └───────────────────────────────────────┘
                                                    │
                                                    ▼
                                     ┌─────────────────────────────────────┐
                                     │  Storage / Logs                      │
                                     │  - SQLite: chat history, contacts    │
                                     │  - reply/no-reply rules per chat     │
                                     └─────────────────────────────────────┘
```

## 3. Components

### 3.1 Baileys Client (core connector)
- Handles auth (QR code scan once, session persisted to disk)
- Emits events: `messages.upsert`, `presence.update`, connection state, contacts sync
- Exposes send functions (`sendMessage`, `readMessages`)

### 3.2 Status Watcher
- Subscribes to status broadcast events
- Auto-marks statuses as read (optionally with a random delay so it looks natural, not instant)
- Optional: log who posted what, for your own reference

### 3.3 Message Router
- First checks: is this message from *you* (self-JID), and is it a voice note? → routes to Voice Command Engine
- Otherwise: is this a chat you've allowed auto-reply on? → routes to AI Reply Engine
- Filters: ignore groups (configurable), ignore muted chats, rate-limit replies per contact

### 3.4 AI Reply Engine
- Detects language (Swahili, English, or mixed/Sheng) — handled natively by the LLM, no separate detector needed
- Maintains short rolling context per chat (last N messages) so replies aren't stateless
- Calls Claude/OpenAI API with a system prompt instructing bilingual, contextual, concise replies
- Sends response back through Baileys

### 3.5 Voice Command Engine
- Triggered only by voice notes sent to/from your own account (private command channel)
- Steps:
  1. Download voice note (Baileys gives you the media buffer)
  2. Transcribe via Whisper API (handles Swahili + English)
  3. Send transcript to LLM with an extraction prompt → returns structured JSON: `{contact_name, message}`
  4. Fuzzy-match `contact_name` against your synced WhatsApp contact list
  5. If confident match → send message; if ambiguous → reply to yourself asking for confirmation/clarification
  6. Send confirmation back to you ("Sent to John: 'I'll be late'")

### 3.6 Storage
- SQLite (or lightweight JSON files for MVP) for:
  - Chat history/context per contact
  - Contact list cache (for fuzzy matching)
  - Per-chat settings (auto-reply on/off, muted, etc.)
- Session credentials stored separately (Baileys auth folder) — treat as sensitive

## 4. Tech Stack Summary

| Layer | Choice |
|---|---|
| WhatsApp connector | Baileys (Node.js) |
| Runtime | Node.js 18+ |
| AI (chat replies + intent extraction) | Claude API or OpenAI API |
| Speech-to-text | OpenAI Whisper API |
| Storage | SQLite (better-sqlite3) |
| Hosting | Small VPS (DigitalOcean/Hetzner), runs 24/7 via PM2 or systemd |
| Process manager | PM2 (auto-restart on crash/disconnect) |

## 5. Data Flow Summary

1. **Incoming message** → Router → AI Reply Engine → LLM call → Baileys sends reply
2. **Incoming status** → Status Watcher → mark as read
3. **Your voice note** → Voice Command Engine → Whisper → LLM intent extraction → contact match → Baileys sends message → confirmation sent back to you

## 6. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Account ban (unofficial library) | Add human-like delays, avoid replying instantly to everything, don't spam groups |
| Session drops / logout | Auto-reconnect logic, persistent auth storage, alert yourself if disconnected |
| Wrong contact match on voice command | Confirmation step before sending if match confidence is low |
| AI replying inappropriately to sensitive chats | Per-chat allow-list; auto-reply off by default for new chats |
| API costs scaling with message volume | Rate-limit auto-replies, cache/short-circuit for common queries |
