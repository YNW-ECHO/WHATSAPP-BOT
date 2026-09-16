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
Link a device. Done — the bot is live on your number.

**Prefer no QR?** Set `OWNER_PHONE` to your number (no `+`, e.g. `254712345678`). The bot then
prints a tiny **8-character pairing code** instead — in WhatsApp choose **Link with phone number**
and type it in. Much easier in Render logs than scanning a huge QR. Leave it empty to use the QR.
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
`KEEPALIVE_URL` in the env — the bot self-pings every 30s. Also add a Render **health
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
| `AI_PROVIDER` | `openai`, `anthropic`, `gemini`, or `groq` (groq/gemini have free-tier keys) |
| `GOOGLE_API_KEY` + `GOOGLE_CX` | live web search (Google CSE, free 100/day) |
| `BOT_NAME` | name shown in replies |
| `ALLOW_GROUPS` | `true` to also auto-reply in groups (off by default) |
| `AUTO_REPLY_DEFAULT` | `true` = new chats auto-reply by default |
| `STATUS_REACTS` | `true` = "like" statuses with an emoji after viewing (life toggle in dashboard) |
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
| `!menu` / `!help` (or `menu` / `help` / `start` in any chat) | the full bot menu |
| `!now` | bot status (connection + contacts count) |
| `!auto on` / `!auto off` | toggle auto-reply for that chat |
| `!mute` / `!unmute` | silence / resume a chat |
| `!voice` / `!text` / `!mode` / `!off` | per-chat reply style on / off / show / pause |
| `!send <name> <message>` | send a message to a contact |
| `!contacts` | count + sync contacts |
| `!time` | current date & time (Nairobi) |
| `!weather [city]` | live weather (no key needed, default Nairobi) |
| Voice note to yourself | “text <name> <message>” → sends it, confirms ✓ |

Anyone who texts this number for the **first time** gets the bot menu as a welcome.
No AI key or config needed for the menu — it always works.

**Quick wins** ⚡
- **Reminders** — in your own chat say *"remind me in 30 min to call Mama"* or *"remind me every Mon at 9am to pay rent"* (daily / weekly on specific days / monthlies — they all repeat automatically). Persisted in SQLite, survive restarts, fire straight into your own chat. `⏰ Reminder set!` confirms.
- **Send media by link** — *"send https://…/photo.jpg to John"* downloads the file (max 10 MB) and delivers it to the named contact (or your own chat when no name is given) as an image / video / document.
- **Daily rundown** — every morning ~07:00 Nairobi time the bot texts your own chat with the date, connection state, contacts, pending reminders and a random remembered fact.

The bot replies with a **17-line-max human touch**: reads first, thinks with the AI, web-searches
when it's a factual/slang question, then types and sends — in English, Swahili or Sheng, matching
the person who wrote you.

**Play a song** 🎵 — in any chat (or your own), type *"play rapstar by polo g"*. The bot finds it on YouTube, asks **mp3** (voice note) or **mp4** (video), and sends the media right into WhatsApp so you can play and save it.

**Style learning** — the bot collects your own outgoing messages and injects up to
`STYLE_SAMPLE_COUNT` of them into the AI prompt as a few-shot style guide, so replies sound
like *you* (not a generic assistant). You can also paste your own messages or **upload a full
WhatsApp chat export** to teach it instantly — manage samples in the dashboard → **Training**.

**Voice-note round-trip** — send the bot a voice note and (with `VOICE_AUTO_REPLY=true` and
ffmpeg installed) it transcribes, replies in text, and sends a voice-note reply it generated
with TTS. Falls back to text-only automatically if TTS/ffmpeg is unavailable. Toggleable live
from the dashboard (Settings → *Reply to voice notes with voice*).

**Status reactions** — besides auto-viewing statuses, the bot can "like" them like a real person
(response emoji, ~55% of the time). Toggle with the `STATUS_REACTS` env var or live from the
dashboard (Settings → *React/like statuses after viewing*).

**Web dashboard** at `http://<host>:<port>/` — Overview (live stats + pairing code), Chats
(auto/mute toggles per chat + history), Devices & Logins (which device/IP/location accessed the
bot), Training (style samples + chat-export importer), and Settings (global pause, status
reactions, voice replies, system prompt override, API key status). Plus a **Re-link WhatsApp**
button that resets the session and prints a fresh pairing code whenever you need to re-link.
Protect it with `DASH_PASSWORD`.

---

## Project layout

```
WHATSAPP BOT/
├─ index.js            entrypoint: HTTP server + bot
├─ src/
│  ├─ config.js        env → config
│  ├─ store.js         SQLite (better-sqlite3): chats, contacts, history, voice/command logs, style samples, settings
│  ├─ session.js       Baileys socket + hot/cooldown + pending commands
│  ├─ ai.js            LLM (OpenAI/Anthropic/Gemini/Groq) + Whisper transcription
│  ├─ search.js        Google CSE + DuckDuckGo fallback
│  ├─ commands.js      owner commands (voice + text)
│  ├─ contacts.js      contact sync + fuzzy resolver
│  ├─ status.js        status viewer (auto mark read + optional reactions)
│  ├─ trainer.js       chat-export parser + training-sample importer
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
