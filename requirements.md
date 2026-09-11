# What You Need To Run The Bot On Your WhatsApp

## Important note first
This bot connects to your **personal WhatsApp number** using an unofficial library (Baileys), the same way "WhatsApp Web" works — not the official paid WhatsApp Business API. The official API does **not** allow auto-viewing statuses or freeform AI auto-replies outside a 24-hour support window, so it isn't a fit for this use case. Unofficial connection carries a small risk of account restriction if used too aggressively — mitigated by rate-limiting, covered in the architecture doc.

## 1. A WhatsApp number to link
- Your existing number, **or** (recommended for safety) a spare/secondary number you don't mind risking
- A phone with WhatsApp installed on that number, to scan the QR code once during setup (like linking WhatsApp Web/Desktop)

## 2. Hosting (must run 24/7)
- A small VPS — options: DigitalOcean, Hetzner, Vultr, Contabo (~$4–6/month tier is enough to start)
- Ubuntu 22.04 or similar
- SSH access to it

## 3. Software on the server
- Node.js 18 or newer
- npm or yarn
- PM2 (or systemd) — keeps the bot running and restarts it if it crashes or disconnects
- Git (to pull/deploy code)
- SQLite (comes bundled with the `better-sqlite3` npm package, no separate install needed)

## 4. API accounts & keys
- **Anthropic (Claude) API key** or **OpenAI API key** — for the AI reply engine and intent extraction
- **OpenAI API key** (specifically) — for Whisper speech-to-text, unless you choose a different STT provider
- A card/billing set up on whichever AI provider(s) you choose — these are pay-as-you-go

## 5. Node packages (installed via npm, no separate download needed)
- `@whiskeysockets/baileys` — WhatsApp connection
- `better-sqlite3` — local storage
- `pm2` (global) — process manager
- `axios` or `node-fetch` — for API calls
- `dotenv` — for managing API keys/config securely

## 6. Configuration you'll need to decide
- Which chats get auto-replies (all, or an allow-list you maintain)
- Whether group messages are included (recommended: off, at least initially)
- The "self-command channel" — confirm you're comfortable using voice notes sent to/from your own chat as the trigger for send-a-message commands
- A system prompt defining the bot's tone/persona for replies

## 7. One-time setup steps (once code is ready)
1. Deploy code to the VPS
2. Set environment variables (API keys) in a `.env` file — never commit this to any public repo
3. Run the bot for the first time → it prints a QR code in the terminal
4. Scan that QR code with WhatsApp on the number you're linking (Settings → Linked Devices → Link a Device)
5. Session is saved — future restarts won't need re-scanning unless you log out or it stays offline too long

## 8. Ongoing costs to expect
| Item | Approx. cost |
|---|---|
| VPS hosting | $4–10/month |
| AI API usage (replies) | Usage-based, depends on volume |
| Whisper transcription | Usage-based, depends on voice command frequency |

## 9. Things you do NOT need
- No official WhatsApp Business API approval
- No Meta developer account
- No dedicated phone kept on 24/7 (once linked, the server maintains the session independently, similar to WhatsApp Web staying logged in)
