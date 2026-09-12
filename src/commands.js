const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('./logger');
const ai = require('./ai');
const contacts = require('./contacts');
const store = require('./store');
const session = require('./session');
const { config } = require('./config');

const silentPino = pino({ level: 'silent' });

const EXTRACT_SYSTEM = `You parse spoken instructions a WhatsApp owner gives their assistant.
Return ONLY a JSON object:
{"contact_name": "<person or phone number to message>", "message": "<exact message text to send>"}
- contact_name: the recipient as the owner said it (e.g. "John", "Mama", "254712345678"). No extra filler words.
- message: the exact words to send, keep the original language (English/Swahili/Sheng).
If the instruction is not about sending a message, return {"contact_name":"","message":""}.`;

function textOf(msg) {
  const m = msg.message || {};
  const c = m.ephemeralMessage?.message || m;
  if (typeof c.conversation === 'string') return c.conversation;
  if (c.extendedTextMessage?.text) return c.extendedTextMessage.text;
  return '';
}

async function sendBack(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    logger.error('sendBack failed:', e.message);
  }
}

async function handleSelfVoice(sock, msg) {
  const jid = msg.key.remoteJid;
  try {
    await sock.readMessages([msg.key]);
  } catch (e) {}
  await sendBack(sock, jid, '🎧 Got it… one sec');

  const m = msg.message || {};
  const audio = m.audioMessage || m?.ephemeralMessage?.message?.audioMessage || {};
  const mime = audio.mimetype || 'audio/ogg';

  let buffer;
  try {
    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentPino });
  } catch (e) {
    return sendBack(sock, jid, 'Could not download that voice note: ' + e.message);
  }

  try {
    const text = await ai.transcribeAudio(buffer, mime);
    if (!text) return sendBack(sock, jid, 'Heard nothing — say it again?');
    logger.info(`voicenote → ${text}`);
    store.addCommandLog(jid, 'voice_command', text.slice(0, 500));
    return await handleVoiceText(sock, jid, text);
  } catch (e) {
    logger.error('voice pipeline failed:', e.message);
    return sendBack(sock, jid, 'Voice note failed: ' + e.message);
  }
}

async function handleVoiceText(sock, ownerJid, text) {
  // If a confirmation menu is pending, a plain number chooses the contact.
  const pending = session.pendingFor(ownerJid);
  if (pending && /^\d{1,2}$/.test(text.trim())) {
    const idx = parseInt(text.trim(), 10) - 1;
    if (pending.contacts[idx]) {
      const c = pending.contacts[idx];
      session.clearPending(ownerJid);
      return actuallySend(sock, ownerJid, c.jid, c.name, pending.message);
    }
    return sendBack(sock, ownerJid, 'That number is not in the list. Try again.');
  }

  let parsed;
  try {
    parsed = await ai.chatJSON(EXTRACT_SYSTEM, text);
  } catch (e) {
    return sendBack(sock, ownerJid, "Couldn't parse that: " + e.message);
  }

  const target = String(parsed.contact_name || '').trim();
  const msgText = String(parsed.message || '').trim();
  if (!target || !msgText) {
    return sendBack(sock, ownerJid, `Say who to text and the message, e.g. "text John, I'll be late".`);
  }
  return resolveAndSend(sock, ownerJid, target, msgText);
}

// Direct send with a resolved target (name or phone number) — no AI needed.
async function resolveAndSend(sock, ownerJid, target, msgText) {
  // Direct phone number?
  const digits = String(target).replace(/[\s+\-()]/g, '');
  if (/^\d{9,12}$/.test(digits)) {
    const intl = digits.startsWith('0') ? '254' + digits.slice(1) : digits;
    return actuallySend(sock, ownerJid, intl + '@s.whatsapp.net', target, msgText);
  }

  const scored = contacts.search(target);
  if (!scored.length) {
    return sendBack(sock, ownerJid, `Couldn't find "${target}" in your contacts. Try the exact name or a phone number.`);
  }

  const top = scored[0];
  const second = scored[1];
  if (top.score >= 0.8 && (!second || second.score < top.score - 0.2)) {
    return actuallySend(sock, ownerJid, top.jid, top.name, msgText);
  }

  const options = scored.slice(0, 3);
  session.setPending(ownerJid, { contacts: options, message: msgText });
  const menu = options.map((c, i) => `${i + 1}) ${c.name}`).join('\n');
  return sendBack(sock, ownerJid, `I found a few:\n${menu}\nReply 1 / 2 / 3 to confirm (or say the full name).`);
}

async function actuallySend(sock, ownerJid, targetJid, name, msgText) {
  try {
    await sock.sendMessage(targetJid, { text: msgText });
    logger.info(`sent → ${name} (${targetJid}): ${msgText}`);
    await sendBack(sock, ownerJid, `Sent ✓ to ${name}: "${msgText}"`);
    store.addCommandLog(ownerJid, 'send', `${name} (${targetJid}): ${msgText.slice(0, 200)}`);
    return true;
  } catch (e) {
    await sendBack(sock, ownerJid, `Couldn't send to ${name}: ${e.message}`);
    store.addCommandLog(ownerJid, 'send', `FAILED ${name}: ${e.message.slice(0, 200)}`);
    return false;
  }
}

async function handleSelfText(sock, msg) {
  const jid = msg.key.remoteJid;
  const t = textOf(msg).trim();
  const words = t.slice(1).split(/\s+/);
  const cmd = (words[0] || '').toLowerCase();

  switch (cmd) {
    case 'send': {
      const target = (words[1] || '').replace(/^@/, '');
      const message = words.slice(2).join(' ');
      if (!target || !message) return sendBack(sock, jid, 'Usage: !send <name or number> <message>');
      return resolveAndSend(sock, jid, target, message);
    }
    case 'now': {
      const s = session.getState();
      return sendBack(
        sock,
        jid,
        `[${config.name}] ${s.connection} • contacts: ${s.contacts} • uptime: ${Math.round((Date.now() - s.startedAt) / 60000)}m`
      );
    }
    case 'help':
      return sendBack(
        sock,
        jid,
        'Commands:\n!send <name> <msg> — send a message\n!now — status\n!auto on | !auto off (any chat) — toggle auto-reply\n!mute / !unmute'
      );
    default:
      return;
  }
}

// !auto / !mute / !unmute — usable in any chat (per-chat toggle)
async function handleChatCommand(sock, msg) {
  const jid = msg.key.remoteJid;
  const t = textOf(msg).trim().toLowerCase();
  if (t.startsWith('!auto off')) {
    store.setAutoReply(jid, false);
    return sendBack(sock, jid, 'Okay, auto-reply off here. Send "!auto on" to turn it back on.');
  }
  if (t.startsWith('!auto on')) {
    store.setAutoReply(jid, true);
    return sendBack(sock, jid, `Back on 🔥 I'll reply from now.`);
  }
  if (t === '!mute') {
    store.setMuted(jid, true);
    return sendBack(sock, jid, 'Muted. Send "!unmute" to unmute.');
  }
  if (t === '!unmute') {
    store.setMuted(jid, false);
    return sendBack(sock, jid, 'Unmuted.');
  }
  if (t === '!voice') {
    store.setReplyMode(jid, 'voice');
    return sendBack(sock, jid, 'Voice replies on here 🎙 Send voice notes and I\'ll reply with a voice note.');
  }
  if (t === '!text') {
    store.setReplyMode(jid, 'text');
    return sendBack(sock, jid, 'Voice replies off — I\'ll reply with text.');
  }
  if (t === '!mode') {
    const mode = (store.getChat(jid) || {}).reply_mode || 'text';
    return sendBack(sock, jid, `Reply mode here: ${mode}. Use "!voice" or "!text" to change.`);
  }
}

module.exports = { handleSelfVoice, handleSelfText, handleVoiceText, handleChatCommand, resolveAndSend };