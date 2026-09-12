const { getContentType, jidNormalizedUser, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const silentPino = pino({ level: 'silent' });
const logger = require('./logger');
const store = require('./store');
const session = require('./session');
const { config } = require('./config');
const statusHandler = require('./status');
const commands = require('./commands');
const replyEngine = require('./reply');
const tts = require('./tts');
const ai = require('./ai');
const facts = require('./facts');
const summarizer = require('./summarizer');

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
    // Can't transcribe → leave the voice note unread (no blue-tick bait).
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
  summarizer.maybeUpdate(jid);

  if (wantVoice) {
    try {
      const ttsAudio = await tts.synthesize(reply);
      if (tts.ffmpegAvailable()) {
        const ogg = await tts.toOgg(ttsAudio);
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        store.addVoiceLog(jid, 'out', reply);
        logger.info(`voice reply sent → ${jid}`);
        await readQuietly(sock, key);
        return;
      }
      logger.warn('ffmpeg unavailable — voice reply degraded to text');
    } catch (e) {
      logger.warn('voice reply failed (falling back to text):', e.message);
    }
  }

  await sock.sendMessage(jid, { text: reply });
  await readQuietly(sock, key);
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

  // The owner's own chat jid. config.ownerJid may be empty in .env, so we
  // also derive it from the linked session number once connected.
  const ownJid = normJid(config.ownerJid) || (() => {
    const n = session.getState().number;
    return n ? normJid(n + '@s.whatsapp.net') : '';
  })();

  // ---- Messages in the owner's own chat (self-chat) ----
  if (fromMe || (ownJid && normJid(jid) === ownJid)) {
    const isOwner = !ownJid || normJid(jid) === ownJid;
    if (isVoice(msg)) {
      if (isOwner) return commands.handleSelfVoice(sock, msg);
      return;
    }
    const t = getText(msg).trim();
    // §3.5 style learning source: the owner's own real texts
    if (t && !t.startsWith('!')) {
      store.addStyleSample(jid, t);
      facts.extractAndStore(t, jid); // fire-and-forget knowledge learning
    }
    if (t.startsWith('!')) {
      if (isOwner) return commands.handleSelfText(sock, msg);
      return;
    }
    if (session.pendingFor(jid)) return commands.handleVoiceText(sock, jid, t);
    return;
  }

  // ---- Incoming messages (from other people) ----
  const chat = store.getChat(jid);
  // Muted / auto-reply disabled: leave the message unread so ticks stay
  // grey until the owner reads it themselves (don't steal blue ticks).
  if (chat.muted || !chat.auto_reply) return;

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
  // Media-only messages (no text): don't read or "reply" to silence — leave
  // them for the owner to see, never steal blue ticks.
  if (!text) return;

  const now = Date.now();
  // Spacing guard: silently throttle, but NEVER read the message — a blue
  // tick with no reply is exactly the "blueticking" bug.
  if (session.isHot(jid, config.minReplySpacing) || now - (chat.last_sent_at || 0) < config.minReplySpacing) {
    return;
  }
  session.markActive(jid);

  // Attach imported person memory the first time this contact starts chatting,
  // so the bot already knows them (never forgets them after that).
  summarizer.attachMemoryFor(jid, store.getContactName(jid));

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
    // Blue tick only AFTER the reply is actually sent.
    await readQuietly(sock, key);
    await session.stopTyping(jid);
    store.setLastSent(jid, Date.now());
    store.addHistory(jid, 'user', text);
    store.addHistory(jid, 'assistant', reply);
    store.addCommandLog(jid, 'reply', reply.slice(0, 120));
    summarizer.maybeUpdate(jid);
  } catch (e) {
    logger.error('auto-reply failed:', jid, e.stack || e.message);
  } finally {
    session.releaseHot(jid);
  }
}

module.exports = { route, getText, isVoice };