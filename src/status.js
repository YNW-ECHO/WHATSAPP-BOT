const { getContentType } = require('@whiskeysockets/baileys');
const logger = require('./logger');
const store = require('./store');
const session = require('./session');
const { config } = require('./config');
const { rand } = require('./human');

const REACTIONS = ['❤️', '😍', '😂', '👍', '🔥', '🙌', '🥰'];

function statusReactsEnabled() {
  // Dashboard toggle lives in DB; falls back to the env default.
  const db = store.getSetting('status_react', config.statusReacts ? '1' : '0');
  return db === '1';
}

async function handleStatus(sock, msg) {
  if (msg.key.fromMe) return; // own status, skip
  const type = getContentType(msg.message);
  if (!type || type.startsWith('protocol')) return;
  if (type === 'reactionMessage') return;

  const sender = msg.key.participant || 'someone';
  const delay = rand(3000, 12000); // not instant → looks natural
  setTimeout(async () => {
    // If the bot reconnected meanwhile, sock is a dead socket — bail out.
    if (session.getSocket() !== sock) return;
    try {
      await sock.readMessages([msg.key]);
      logger.info(`viewed status by ${sender}`);
      store.addCommandLog(sender, 'status_view', 'status auto-viewed');

      // Optionally "like"/react to the status like a real person would.
      if (statusReactsEnabled() && msg.key.remoteJid === 'status@broadcast') {
        const emoji = REACTIONS[rand(0, REACTIONS.length - 1)];
        await sock.sendMessage(msg.key.remoteJid, {
          react: { text: emoji, key: msg.key },
        });
        logger.info(`reacted ${emoji} to a status`);
        store.addCommandLog(sender, 'reaction', `reacted ${emoji} to status`);
      }
    } catch (e) {
      logger.warn('status handler error:', e.message);
    }
  }, delay);
}

module.exports = { handleStatus, statusReactsEnabled };