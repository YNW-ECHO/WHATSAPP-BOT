const { getContentType } = require('@whiskeysockets/baileys');
const logger = require('./logger');
const store = require('./store');
const { rand } = require('./human');

async function handleStatus(sock, msg) {
  if (msg.key.fromMe) return; // own status, skip
  const type = getContentType(msg.message);
  if (!type || type.startsWith('protocol')) return;
  if (type === 'reactionMessage') return;

  const sender = msg.key.participant || 'someone';
  const delay = rand(3000, 12000); // not instant → looks natural
  setTimeout(async () => {
    try {
      await sock.readMessages([msg.key]);
      logger.info(`viewed status by ${sender}`);
      store.addCommandLog(sender, 'status_view', 'status auto-viewed');
    } catch (e) {}
  }, delay);
}

module.exports = { handleStatus };