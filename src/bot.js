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

// Compact QR: capture qrcode-terminal output, strip the quiet-zone margins,
// and render each cell at half width (1 char instead of 2) so it fits easily
// in the Render log viewer.
function printQR(qr) {
  let out = '';
  const original = process.stdout.write;
  const patch = process.stdout.write;
  process.stdout.write = (chunk, enc, cb) => {
    out += chunk;
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    qrcode.generate(qr, { small: true });
  } catch (e) {}
  process.stdout.write = original;
  void patch;

  const lines = out.split('\n');
  const stripped = lines
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      // 2-char cells → 1 char (use the first "pixel" char of each pair)
      let halved = '';
      for (let i = 0; i < l.length; i += 2) halved += l[i];
      return halved;
    });
  // crop empty margin rows (top/bottom quiet zone)
  const first = stripped.findIndex((l) => /[█▀▄ ]/.test(l));
  const last = stripped.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0).pop();
  const body = stripped.slice(first, last + 1);
  // trim horizontal quiet-zone columns
  const min = Math.min(...body.map((l) => l.indexOf('█') >= 0 ? l.indexOf('█') : Infinity));
  const compact = body.map((l) => l.slice(min));
  logger.info(`——— NEW QR — scan it in WhatsApp → Settings → Linked Devices ———`);
  for (const l of compact) process.stdout.write(l + '\n');
  void original;
}

let restarting = false;
let pairingRequested = false;

async function tryPairingCode(sock) {
  if (pairingRequested) return;
  try {
    const code = await sock.requestPairingCode(config.ownerPhone);
    pairingRequested = true;
    logger.info('PAIRING CODE — in WhatsApp: Settings → Linked devices → Link a device → "Link with phone number"');
    logger.info(`Enter this code: ${code}`);
  } catch (e) {
    logger.warn('pairing code failed, showing QR instead:', e.message);
    pairingRequested = false;
  }
}

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

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // If the owner's number is known, prefer a tiny pairing CODE over a huge QR.
      // WhatsApp: Settings → Linked devices → Link a device → Link with phone number.
      if (config.ownerPhone) {
        await tryPairingCode(sock);
        return;
      }
      printQR(qr);
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

  sock.ev.on('contacts.upsert', (contacts = []) => {
    for (const c of contacts || []) {
      const jid = c.id || c.lid || '';
      const name = c.name || c.notify || c.verifiedName || '';
      if (jid && name) store.saveContact(jid, name);
    }
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