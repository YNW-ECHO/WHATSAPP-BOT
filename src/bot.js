const path = require('path');
const fs = require('fs');
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

const DEVICE_NAMES = {
  0: 'Desktop',
  1: 'App/Launcher',
  2: 'iPad',
  3: 'iPhone',
  4: 'Web',
  5: 'Other',
  7: 'Android',
};

function deviceName(n) {
  if (n == null) return 'Unknown';
  return DEVICE_NAMES[n] || `Device ${n}`;
}

function findAuthDir() {
  return process.env.AUTH_DIR || path.join(process.cwd(), 'auth-info');
}

let currentSock = null;
let restarting = false;
let pairingRequested = false;

// Compact QR for the Render log viewer.
function printQR(qr) {
  let out = '';
  const original = process.stdout.write;
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

  const lines = out.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const body = lines.map((l) => {
    let halved = '';
    for (let i = 0; i < l.length; i += 2) halved += l[i];
    return halved;
  });
  logger.info(`——— NEW QR — scan it in WhatsApp → Settings → Linked Devices ———`);
  for (const l of body.slice(0, 24)) process.stdout.write(l + '\n');
}

async function tryPairingCode(sock) {
  if (pairingRequested) return;
  try {
    const code = await sock.requestPairingCode(config.ownerPhone);
    pairingRequested = true;
    session.setPairingCode(code);
    logger.info('PAIRING CODE — in WhatsApp: Settings → Linked devices → "Link with phone number"');
    logger.info(`Enter this code: ${code}`);
  } catch (e) {
    logger.warn('pairing code failed, showing QR instead:', e.message);
    session.setPairingCode('');
    pairingRequested = false;
  }
}

function recordConnection() {
  const user = currentSock?.user;
  const jid = user?.id ? jidNormalizedUser(user.id) : '';
  const number = jid.split('@')[0] || jid;
  const device = deviceName(user?.device) + ' · macOS Chrome';
  session.setDeviceInfo({
    number,
    device,
    connected: true,
    connection: 'open',
    lastLoginAt: Date.now(),
  });
  if (number) {
    store.addDeviceLogin({
      kind: 'whatsapp',
      number,
      device,
      ip: '',
      location: '',
      detail: `Linked guest device (${device})`,
    });
  }
}

async function startBot() {
  store.init();
  const authDir = findAuthDir();
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
  currentSock = sock;
  session.setSocket(sock);
  session.setState({ connection: 'connecting', connected: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.setQr(qr);
      if (config.ownerPhone) {
        await tryPairingCode(sock);
        return;
      }
      printQR(qr);
    }

    if (connection === 'open') {
      pairingRequested = false;
      recordConnection();
      logger.info(`Connected as ${session.getState().number}`);
      contacts.sync(sock).then((n) => session.setState({ contacts: n })).catch(() => {});
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      session.setState({ connection: 'closed', connected: false });
      if (code === DisconnectReason.loggedOut) {
        logger.error('Logged out of WhatsApp. Use the dashboard "Re-link" button to reconnect.');
        session.setState({ pairingCode: '', qr: '' });
        return;
      }
      logger.warn('Connection closed, reconnecting in a few seconds…', { code });
      scheduleRestart(code);
    }
  });

  // Feed self-id into config early when Baileys sets it.
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

  sock.ev.on('contacts.upsert', (contactsList = []) => {
    for (const c of contactsList || []) {
      const jid = c.id || c.lid || '';
      const name = c.name || c.notify || c.verifiedName || '';
      if (jid && name) store.saveContact(jid, name);
    }
    contacts.sync(sock).then((n) => session.setState({ contacts: n })).catch(() => {});
  });

  logger.info('Bot started. Use the dashboard → Re-link to get a pairing code if not connected.');
}

async function scheduleRestart(code) {
  if (restarting) return;
  restarting = true;
  // Timeouts (408) usually mean no WhatsApp connectivity: back off so we
  // don't hammer the server every 3 s when offline. Reconnects happen
  // manually via the dashboard Re-link button anyway.
  const delay = code === 408 ? 15000 : 3000;
  logger.info(`Restarting in ${delay / 1000}s…`);
  await sleep(delay);
  try {
    await startBot();
  } catch (e) {
    logger.error('restart failed:', e.message);
  }
  restarting = false;
}

// Dashboard "Re-link" button: back up the session, log out, wipe it, and
// start fresh so a new pairing code/QR is produced for WhatsApp.
async function relink() {
  session.setState({ relinkPending: true, pairingCode: '', qr: '', connected: false, connection: 'relinking' });
  const authDir = findAuthDir();
  const backup = authDir + '.bak';
  try {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.cpSync(authDir, backup, { recursive: true, force: true });
  } catch (e) {
    logger.warn('relink backup failed:', e.message);
  }

  const sock = currentSock;
  currentSock = null;
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      logger.warn('logout failed:', e.message);
    }
  }

  pairingRequested = false;
  try {
    fs.rmSync(authDir, { recursive: true, force: true });
  } catch (e) {
    logger.warn('relink wipe failed:', e.message);
  }

  try {
    await startBot();
  } catch (e) {
    logger.error('relink start failed:', e.message);
    session.setState({ relinkPending: false });
    return { ok: false, error: e.message };
  }

  // Poll briefly so the pairing code is ready when the response lands.
  for (let i = 0; i < 20; i++) {
    const code = session.getState().pairingCode;
    if (code) {
      logger.info(`relink: code ready → ${code}`);
      return { ok: true, code, number: config.ownerPhone || '' };
    }
    await sleep(500);
  }
  session.setState({ relinkPending: false });
  return { ok: true, code: session.getState().pairingCode, number: config.ownerPhone || '' };
}

module.exports = { startBot, relink, deviceName };