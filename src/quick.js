const logger = require('./logger');
const store = require('./store');
const session = require('./session');
const contacts = require('./contacts');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': '*/*',
};
const MAX_MEDIA = 10 * 1024 * 1024; // 10 MB cap keeps WhatsApp happy

/* ============================ time ============================ */

function timeText() {
  try {
    const d = new Date();
    const time = d.toLocaleTimeString('en-KE', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Nairobi',
    });
    const date = d.toLocaleDateString('en-KE', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi',
    });
    return `🕐 *Time (Nairobi)*\n📅 ${date}\n⏰ ${time}`;
  } catch (e) {
    return `🕐 ${new Date().toLocaleString()}`;
  }
}

/* ============================ weather ============================ */

async function weather(city) {
  const q = String(city || '').trim() || 'Nairobi';
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(q)}?format=%C+%c+%t+%w+%h`, {
      headers: UA, signal: AbortSignal.timeout(12000), redirect: 'follow',
    });
    if (!res.ok) return `🌦️ No weather for "${q}" right now.`;
    const txt = (await res.text()).trim().replace(/\s+/g, ' ');
    if (!txt) return `🌦️ No weather for "${q}" right now.`;
    // wttr gives: "Partly cloudy ☀️ +24°C 15km/h 45%"
    const parts = txt.split(/[\s+]+/);
    const temp = parts.find((p) => p.includes('°')) || '';
    const wind = parts.find((p) => p.toLowerCase().includes('km/h')) || '';
    const hum = parts.find((p) => p.includes('%')) || '';
    const desc = parts.filter((p) => p !== temp && !p.toLowerCase().includes('km/h') && !p.includes('%')).join(' ');
    return [
      `🌦️ *Weather · ${q === 'Nairobi' ? 'Nairobi' : q}*`,
      `• ${desc.replace(/^\+/, '')}`,
      temp ? `• 🌡️ ${temp}` : '',
      wind ? `• 💨 ${wind}` : '',
      hum ? `• 💧 ${hum}` : '',
    ].filter(Boolean).join('\n');
  } catch (e) {
    logger.warn('weather fetch failed:', e.message);
    return `🌦️ Couldn't fetch weather for "${q}" (${e.message || 'network error'}).`;
  }
}

/* ============================ send media by link ============================ */

const SEND_URL_RE = /^(?:send|send\s+this|share\s+this?)\s+(https?:\/\/[^\s]+)(?:\s+(?:to|for)\s+(.+))?$/i;

// True only if something in `text` downloads a URL and forwards it as media.
async function handleMediaSend(sock, jid, text, requesterName) {
  const m = String(text || '').trim().match(SEND_URL_RE);
  if (!m) return false;
  const url = m[1].replace(/[,;]\s*$/, '');
  const targetRaw = m[2] ? m[2].trim() : '';

  // resolve target: explicit name/number, otherwise send to the requester's own chat
  let targetJid = jid;
  let targetName = requesterName || 'you';
  let label = 'here in your chat';
  if (targetRaw) {
    const hit = contacts.search(targetRaw.replace(/["]/g, ''))[0];
    const digits = targetRaw.replace(/\D/g, '');
    if (hit) {
      targetJid = hit.jid;
      targetName = hit.name || hit.jid.replace(/@.*/, '');
      label = targetName;
    } else if (/^\d{9,15}$/.test(digits)) {
      targetJid = digits + '@s.whatsapp.net';
      targetName = targetRaw;
      label = targetRaw;
    } else {
      await sock.sendMessage(jid, { text: `🤔 Couldn't find "${targetRaw}" in your contacts.` });
      return true;
    }
  }

  return fetchAndSend(sock, jid, url, targetJid, label, targetName);
}

async function fetchAndSend(sock, fromJid, url, targetJid, label, targetName) {
  const note = async (t) => {
    try { await sock.sendMessage(fromJid, { text: t }); } catch (e) {}
  };
  await note(`📥 Downloading ${url} …`);
  let res;
  try {
    res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  } catch (e) {
    await note(`❌ Couldn't download: ${e.message}`);
    return true;
  }
  if (!res.ok) {
    await note(`❌ Download failed (HTTP ${res.status}).`);
    return true;
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_MEDIA) {
    await note(`❌ That file is too big to send on WhatsApp (max 10 MB).`);
    return true;
  }
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    await note(`❌ Download interrupted: ${e.message}`);
    return true;
  }
  if (buf.length <= 0) {
    await note(`❌ That link returned no data.`);
    return true;
  }
  if (buf.length > MAX_MEDIA) {
    await note(`❌ That file is too big to send on WhatsApp (max 10 MB).`);
    return true;
  }
  const ctype = String(res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  try {
    if (ctype.startsWith('image/')) {
      await sock.sendMessage(targetJid, { image: buf, caption: url });
    } else if (ctype.startsWith('video/')) {
      await sock.sendMessage(targetJid, { video: buf, caption: url });
    } else {
      const fn = decodeURIComponent(String(new URL(url).pathname.split('/').pop() || 'file'))
        .replace(/[^\w.\-]+/g, '_') || 'downloaded';
      await sock.sendMessage(targetJid, { document: buf, fileName: fn, mimetype: ctype || 'application/octet-stream', caption: url });
    }
  } catch (e) {
    await note(`❌ Couldn't deliver as media: ${e.message}`);
    return true;
  }
  await note(`✅ Sent ✓ to *${label}* (${buf.length > 1024 * 1024 ? (buf.length / 1048576).toFixed(1) + ' MB' : Math.round(buf.length / 1024) + ' KB'})`);
  store.addCommandLog(fromJid, 'chat_command', `media sent: ${url} → ${targetJid}`);
  return true;
}

/* ============================ daily rundown ============================ */

let dailyStarted = false;

function nairobiParts() {
  const opts = { timeZone: 'Africa/Nairobi', hour12: false };
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', ...opts }).formatToParts(new Date());
  let h = 0, m = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = parseInt(p.value, 10);
    if (p.type === 'minute') m = parseInt(p.value, 10);
  }
  return { h, m };
}

// Every morning ~7:00 Nairobi time the bot texts the owner's own chat with a rundown.
function startDaily() {
  if (dailyStarted) return;
  dailyStarted = true;
  setInterval(async () => {
    try {
      if (!session.getState().connected) return;
      const today = new Date().toISOString().slice(0, 10);
      if (store.getSetting('daily_sent_on', '') === today) return;
      const { h, m } = nairobiParts();
      if (h !== 7 || m > 15) return;

      const sock = session.getSocket();
      if (!sock) return;
      const num = String(session.getState().number || '').replace(/\D/g, '');
      if (!num) return;
      const jid = num + '@s.whatsapp.net';

      const s = session.getState();
      const up = s.startedAt ? Math.round((Date.now() - s.startedAt) / 60000) : 0;
      const facts = store.getFacts(50);
      const fact = facts.length ? facts[Math.floor(Math.random() * facts.length)] : null;
      const pendingR = store.countPendingReminders();
      const date = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Nairobi' });

      const lines = [
        `🌅 *Good morning!* It's ${date} ☀️`,
        `• 📶 ${s.connected ? 'online ✅' : 'connecting…'}`,
        `• 👥 contacts: ${s.contacts} · ⏱️ uptime: ${up}m`,
        `• ⏰ reminders queued: ${pendingR}`,
      ];
      if (fact) lines.push(`• 🧠 fact I remember: ${fact.fact.length > 160 ? fact.fact.slice(0, 160) + '…' : fact.fact}`);
      lines.push('', 'Have a great day! — CHRIS 🤖');

      await sock.sendMessage(jid, { text: lines.join('\n') });
      store.setSetting('daily_sent_on', today);
      logger.info('daily rundown sent');
    } catch (e) {
      logger.warn('daily rundown error:', e.message);
    }
  }, 60000);
}

module.exports = { timeText, weather, handleMediaSend, startDaily, nairobiParts };