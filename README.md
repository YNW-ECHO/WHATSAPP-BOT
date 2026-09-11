# WHATAPP BOT — your personal WhatsApp AI assistant

A Node.js bot (Baileys) that turns your **own WhatsApp number** into an assistant that replies
like a real person. Built and tested end-to-end for Render's **free tier**.

**What it actually does:**

- ✅ **Auto-views statuses** (marks them read after a natural human delay — no account red flags)
- ✅ **Auto-replies to your chats** using AI that understands **English, Swahili and Kenyan Sheng**,
  and answers in the same register the person used (Karibu, niaje, ganji…)
- ✅ **Types like a human** — reads at a natural pace, shows “typing…”, keeps a short per-chat
  memory so replies aren’t stateless
- ✅ **Finds facts on the web** (Google Custom Search or DuckDuckGo fallback) so slang, prices,
  news and “kenyan sheng“ answers stay accurate and current
- ✅ **Owner voice commands**: send a **voice note to yourself** like
  *“text mama I’ll be home by 8”* → it finds “Mama” in your contacts, sends the message, and
  confirms back to you. Voice notes are transcribed with **Whisper**.
- ✅ Owner text commands too — `!send <name> <message>`, `!auto on/off`, `!mute`, `!contacts`, `!now`
- ✅ Human behavior: random read delays, typing indicators, per-chat cooldowns, only replies to
  chats you allow, groups off by default → minimal ban risk on your personal number

> ⚠️ **Important:** this uses the **unofficial** Baileys library (same as “WhatsApp Web” linked
> devices), **not** the paid WhatsApp Business API. Use a **spare/secondary number** you don’t
> mind risking, keep auto-reply off in groups, and the human delays/rate-limits are built in to
> keep it safe. WhatsApp can restrict accounts that spam — this bot is intentionally conservative.

---

## What you need

1. **One of these AI keys** (the bot replies with it):
   - `OPENAI_API_KEY` *(OpenAI — also used for Whisper voice notes if no ISAPI)*
   - or `ANTHROPIC_API_KEY`
2. (Optional, for live web facts) a free Google **Custom Search JSON API** key + a
   **Programmable Search Engine** ID → `GOOGLE_API_KEY` + `GOOGLE_CX`. If you skip them the bot
   falls back to DuckDuckGo search (no key needed).
3. A **Render account** (free) — and optionally a **Render free cron/uptime** setup.
4. Your WhatsApp number (spare recommended) with WhatsApp installed to scan the QR once.

---

## Run it locally (test in ~2 minutes)

```bash
npm install
cp .env.example .env      # then edit .env and add your keys
npm start
```

A **QR code** prints in the terminal → scan it from WhatsApp → Settings → Linked Devices →
Link a device. Done — the bot is live on your number)Skip
You can use **`!auto on/off`** in any chat, **`!mute`/`!unmute`**, and the web search/AI are on.

---

## Deploy on Render (free tier) — the way I made it

Render blueprints let you deploy the included `render.yaml` with almost no clicks. Two paths:

### Option A — manual Web Service (recommended for testing, free)
1. Put this folder in a **GitHub repo** (private is fine).
2. Render → **New + → Web Service** → connect the repo.
3. Runtime: **Node** — Build: `npm install` — Start: `node index.js`.
4. Add environment variables (same as `.env.example`): your API keys, `PORT`, `OWNER_JID`
   (optional), `BOT_NAME`, `KEEPALIVE_URL`.
5. Deploy → open the logs → a QR prints → scan it once. Session is saved on disk, so restarts
   just reconnect.

### Option B — Blueprint (one-click)
On Render, **New + → Blueprint** → pick the repo → it reads `render.yaml` automatically with the
right build/start/health config. Set the envs in the service.

### Keeping the free instance awake
The bot runs a tiny HTTP server with **`/health`** and **`/`** endpoints. Set your service URL as
`KEEPALIVE_URL` in the env — the bot self-pings every few minutes. Also add a Render **health
check path** `/health` so Render keeps it healthy and your free service doesn't sleep. (Free tier
still sleeps after ~15 min of inactivity on Render; the keep-alive self-ping keeps it from doing
so — and if it does sleep, the bot auto-reconnects on Render's next ping. For 24/7 uptime on the
free tier this is the standard friend-approved trick.)

### Render free-tier notes
- Free instances have an **ephemeral disk**: the session (auth-info) exists only while the
  service runs. On redeploy/restart you may need to **rescan the QR once**. That's expected for
  the free test — upgrade to a paid VPS/docker disk if you want persistence.
- Better still: any plain VPS (DigitalOcean/Hetzner ~$4-6/mo) or even your laptop running
  `npm start` 24/7 works — the code is fully portable.

---

## Configuration (all optional except an AI key)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | AI replies (and Whisper voice) |
| `AI_PROVIDER` | `openai` (default) or `anthropic` |
| `GOOGLE_API_KEY` + `GOOGLE_CX` | live web search (Google CSE, free 100/day) |
| `BOT_NAME` | name shown in replies |
| `ALLOW_GROUPS` | `true` to also auto-reply in groups (off by default) |
| `AUTO_REPLY_DEFAULT` | `true` = new chats auto-reply by default |
| `OWNER_JID` | your `2547XXXXXXXX@s.whatsapp.net` (auto-detects if empty) |
| `KEEPALIVE_URL` | your Render service URL (self-ping so free tier stays awake) |
| `PORT` | set by Render automatically |
| `VOICE_AUTO_REPLY` | `true` = reply to voice notes with a voice note (needs TTS + ffmpeg) |
| `TTS_PROVIDER` | `openai` (default) or `elevenlabs` |
| `TTS_VOICE` | OpenAI TTS voice id (default `alloy`) |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | ElevenLabs TTS (if `TTS_PROVIDER=elevenlabs`) |
| `WHISPER_API_KEY` | falls back to `OPENAI_API_KEY` if empty |
| `STYLE_SAMPLE_COUNT` | how many of your own texts feed the AI style (default 30, `0` disables) |
| `DASH_PASSWORD` / `DASH_USER` | web dashboard login (set a real password!) |
| `DASH_HOST` | dashboard bind host (default `0.0.0.0`) |

---

## Commands & voice

| Command | What it does |
|---|---|
| `!help` | show commands |
| `!now` | bot status (connection + contacts count) |
| `!auto on` / `!auto off` | toggle auto-reply for that chat |
| `!mute` / `!unmute` | silence / resume a chat |
| `!voice` / `!text` / `!mode` | per-chat voice-reply mode on / off / show |
| `!send <name> <message>` | send a message to a contact |
| `!contacts` | count + sync contacts |
| Voice note to yourself | “text <name> <message>” → sends it, confirms ✓ |

The bot replies with a **17-line-max human touch**: reads first, thinks with the AI, web-searches
when it's a factual/slang question, then types and sends — in English, Swahili or Sheng, matching
the person who wrote you.

**Style learning** — the bot collects your own outgoing messages and injects up to
`STYLE_SAMPLE_COUNT` of them into the AI prompt as a few-shot style guide, so replies sound
like *you* (not a generic assistant). Manage samples in the dashboard → Settings.

**Voice-note round-trip** — send the bot a voice note and (with `VOICE_AUTO_REPLY=true` and
ffmpeg installed) it transcribes, replies in text, and sends a voice-note reply it generated
with TTS. Falls back to text-only automatically if TTS/ffmpeg is unavailable.

**Web dashboard** at `http://<host>:<port>/` — overview, conversations, contacts, voice log,
command log, settings (global pause, system prompt override, API key status, style samples)
and chat history. Protect it with `DASH_PASSWORD`.

---

## Project layout

```
WHATSAPP BOT/
├─ index.js            entrypoint: HTTP server + bot
├─ src/
│  ├─ config.js        env → config
│  ├─ store.js         SQLite (better-sqlite3): chats, contacts, history, voice/command logs, style samples, settings
│  ├─ session.js       Baileys socket + hot/cooldown + pending commands
│  ├─ ai.js            LLM (OpenAI/Anthropic) + Whisper transcription
│  ├─ search.js        Google CSE + DuckDuckGo fallback
│  ├─ commands.js      owner commands (voice + text)
│  ├─ contacts.js      contact sync + fuzzy resolver
│  ├─ status.js        status viewer (auto mark read)
│  ├─ router.js        message router (text + voice-note pipes)
│  ├─ human.js         human delays (read/typing/sleep)
│  ├─ tts.js           text-to-speech (OpenAI / ElevenLabs → ogg via ffmpeg)
│  ├─ server.js        dashboard HTTP server + keepalive
│  └─ logger.js
├─ requirements.md / architecture.md
├─ render.yaml
└─ .env.example
```

---

## Notes

- Built for a Kenyan user 🇰🇪 — replies match Sheng/Swahili so it feels like a real friend, not a bot.
- Not affiliated with WhatsApp/Meta. Use responsibly with your own number.
- Suggestions & PRs welcome. Enjoy!

*Made with ☕ + Baileys for Render free tier.*
