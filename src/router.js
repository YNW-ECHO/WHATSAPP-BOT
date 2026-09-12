const { getContentType, jidNormalizedUser, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const silentPino = pino({ level: 'silent' });
const logger = require('./logger');
const store = require('./store');
const session = require('./session');
const { config } = require('./config');
const { readDelay } = require('./human');
const statusHandler = require('./status');
const commands = require('./commands');
const replyEngine = require('./reply');
const tts = require('./tts');
const ai = require('./ai');

function unwrap(msg) {
  const m = msg.message || {};
  if (m.ephemeralMessage?.message) return m.ephemeralMessage.message;
  if (m.editedMessage) return m.editedMessage;
  return m;
}

function getText(msg) {
  const m = unwrap(msg);
  if (!m) return '';
  if (typeof m.conversation === 'string') return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  return '';
}

function isVoice(msg) {
  return !!unwrap(msg)?.audioMessage?.ptt;
}

function isSticker(msg) {
  return !!unwrap(msg)?.stickerMessage;
}

function normJid(jid) {
  try {
    return jidNormalizedUser(jid);
  } catch (e) {
    return String(jid || '').split(':')[0];
  }
}

async function readQuietly(sock, key) {
  try {
    await sock.readMessages([key]);
  } catch (e) {}
}

// ---- §3.6 Voice-note → voice-note reply ---------------------------------
// Incoming voice note from a contact: Whisper transcribe → AI reply text →
// TTS → ffmpeg → .ogg/Opus ptt bubble. Falls back to text reply gracefully
// when voice reply is disabled, TTS keys are missing, or ffmpeg is absent.
async function handleVoiceReply(sock, msg, key, jid, audio) {
  const mime = audio.mimetype || 'audio/ogg';
  let buffer;
  try {
    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentPino });
  } catch (e) {
    logger.warn('voice download failed:', e.message);
    return;
  }

  let transcript = '';
  try {
    transcript = await ai.transcribeAudio(buffer, mime);
  } catch (e) {
    logger.warn('transcribe failed:', e.message);
  }
  if (!transcript) {
    await readQuietly(sock, key);
    return;
  }
  store.addVoiceLog(jid, 'in', transcript);

  const mode = (store.getChat(jid) || {}).reply_mode || 'text';
  const voiceEnabled = store.getSetting('voice_auto', config.voiceAutoReply ? '1' : '0') === '1';
  const wantVoice = voiceEnabled && mode !== 'text';

  const reply = await replyEngine.createReply(sock, jid, transcript);
  if (!reply) return;

  store.setLastSent(jid, Date.now());
  store.addHistory(jid, 'user', transcript);
  store.addHistory(jid, 'assistant', reply);
  store.addCommandLog(jid, 'reply', reply.slice(0, 120));

  if (wantVoice) {
    try {
      const ttsAudio = await tts.synthesize(reply);
      if (tts.ffmpegAvailable()) {
        const ogg = await tts.toOgg(ttsAudio);
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        store.addVoiceLog(jid, 'out', reply);
        logger.info(`voice reply sent → ${jid}`);
        return;
      }
      logger.warn('ffmpeg unavailable — voice reply degraded to text');
    } catch (e) {
      logger.warn('voice reply failed (falling back to text):', e.message);
    }
  }

  await sock.sendMessage(jid, { text: reply });
}

async function route(sock, msg) {
  const key = msg.key || {};
  const jid = key.remoteJid || '';
  if (!jid || !msg.message) return;

  if (key.id) store.saveRaw(key.id, msg.message);

  // ---- Status broadcasts ----
  if (jid === 'status@broadcast') return statusHandler.handleStatus(sock, msg);

  const fromMe = !!key.fromMe;
  const type = getContentType(msg.message);
  if (!type || ['protocolMessage', 'reactionMessage', 'pollUpdateMessage'].includes(type)) return;

  const isGroup = jid.endsWith('@g.us');

  // ---- Global pause switch (dashboard setting) ----
  if (store.isGlobalPaused()) return;

  // ---- Messages from the owner (you) ----
  if (fromMe) {
    const isOwner = !config.ownerJid || normJid(jid) === normJid(config.ownerJid);
    if (isVoice(msg)) {
      if (isOwner) return commands.handleSelfVoice(sock, msg);
      return;
    }
    const t = getText(msg).trim();
    // §3.5 style learning source: the owner's own real texts
    if (t && !t.startsWith('!')) store.addStyleSample(jid, t);
    if (t.startsWith('!')) {
      if (isOwner) return commands.handleSelfText(sock, msg);
      return;
    }
    if (session.pendingFor(jid)) return commands.handleVoiceText(sock, jid, t);
    return;
  }

  // ---- Incoming messages (from other people) ----
  const chat = store.getChat(jid);
  if (chat.muted || !chat.auto_reply) {
    await readQuietly(sock, key);
    return;
  }

  // §3.6 Voice notes from contacts
  if (isVoice(msg)) {
    if (isGroup && !config.allowGroups) {
      await readQuietly(sock, key);
      return;
    }
    return handleVoiceReply(sock, msg, key, jid, unwrap(msg).audioMessage || {});
  }

  const text = getText(msg);
  if (text.startsWith('!')) {
    if (/^!\s*(auto|mute|unmute|voice|text|mode)/.test(text)) return commands.handleChatCommand(sock, msg);
    return;
  }
  if (isGroup && !config.allowGroups) return;
  if (isSticker(msg)) return;

  const now = Date.now();
  if (session.isHot(jid, config.minReplySpacing) || now - (chat.last_sent_at || 0) < config.minReplySpacing) {
    await readQuietly(sock, key);
    return;
  }
  session.markActive(jid);

  // Human-like: mark as read after a short delay (don't block the reply path)
  const rd = readDelay(text.length + 5);
  setTimeout(() => readQuietly(sock, key), rd);

  try {
    // Generate the reply (fast AI, may fetch web info) …
    const replyPromise = replyEngine.createReply(sock, jid, text);
    // … while the "typing" indicator is showing, so it feels like a real person typing.
    const typingPromise = session.simulateTyping(jid, text.length);
    const reply = await Promise.resolve(replyPromise);
    await typingPromise;

    if (!reply) {
      session.releaseHot(jid);
      return;
    }
    await sock.sendMessage(jid, { text: reply });
    await session.stopTyping(jid);
    store.setLastSent(jid, Date.now());
    store.addHistory(jid, 'user', text);
    store.addHistory(jid, 'assistant', reply);
    store.addCommandLog(jid, 'reply', reply.slice(0, 120));
  } catch (e) {
    logger.error('auto-reply failed:', jid, e.stack || e.message);
  } finally {
    session.releaseHot(jid);
  }
}

module.exports = { route, getText, isVoice };