const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const logger = require('./logger');
const { config } = require('./config');
const store = require('./store');
const session = require('./session');
const contacts = require('./contacts');
const router = require('./router');
const { sleep } = require('./human');

let restarting = false;

async function startBot() {
  store.init();

  const authDir = process.env.AUTH_DIR || path.join(process.cwd(), 'auth-info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const baileysLogger = pino({ level: process.env.DEBUG ? 'debug' : 'silent' });

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    logger: baileysLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => store.getRaw(key.id) || { conversation: '' },
  });

  session.setSocket(sock);
  session.setState({ connection: 'connecting', connected: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('——— NEW QR — scan it in WhatsApp → Settings → Linked Devices ———');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      let selfJid = '';
      try {
        selfJid = jidNormalizedUser(sock.user?.id || '');
      } catch (e) {}
      if (!config.ownerJid && selfJid) config.ownerJid = selfJid;
      session.setState({ connection: 'open', connected: true });
      logger.info(`Connected as ${config.ownerJid || selfJid}`);
      contacts.sync(sock).then(() => {
        session.setState({ contacts: store.countContacts() });
      }).catch(() => {});
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      session.setState({ connection: 'closed', connected: false });
      if (code === DisconnectReason.loggedOut) {
        logger.error('Logged out of WhatsApp. Delete the auth-info folder and restart to rescan the QR.');
        return;
      }
      logger.warn('Connection closed, reconnecting in a few seconds…', { code });
      scheduleRestart();
    }
  });

  // Keep self-id fed into config even before "open" (Baileys sets it early sometimes)
  if (!config.ownerJid && sock.user?.id) {
    try {
      config.ownerJid = jidNormalizedUser(sock.user.id);
    } catch (e) {}
  }

  sock.ev.on('messages.upsert', ({ messages = [] }) => {
    for (const msg of messages) {
      try {
        router.route(sock, msg);
      } catch (e) {
        logger.error('router error:', e.message);
      }
    }
  });

  sock.ev.on('contacts.upsert', () => {
    contacts.sync(sock).catch(() => {});
  });

  logger.info('Bot started. Waiting for QR…');
}

async function scheduleRestart() {
  if (restarting) return;
  restarting = true;
  logger.info('Restarting in 3s…');
  await sleep(3000);
  try {
    await startBot();
  } catch (e) {
    logger.error('restart failed:', e.message);
  }
  restarting = false;
}

module.exports = { startBot };