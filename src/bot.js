const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
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
const reminders = require('./reminders');
const quick = require('./quick');
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

// Last-known-good WhatsApp Web version, used only when the live check fails.
const FALLBACK_WA_VERSION = [2, 3000, 1033893291];
let resolvedWAVersion = null;

async function resolveWAVersion() {
  if (resolvedWAVersion) return resolvedWAVersion;
  try {
    const { version } = await fetchLatestBaileysVersion({ timeout: 10000 });
    resolvedWAVersion = version;
    logger.info(`Using WhatsApp Web version ${version.join('.')}`);
  } catch (e) {
    logger.warn('Failed to fetch latest WhatsApp version, using fallback:', e.message);
    resolvedWAVersion = FALLBACK_WA_VERSION;
  }
  return resolvedWAVersion;
}

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

async function tryPairingCode(sock, phone) {
  if (pairingRequested) return;
  phone = phone || config.ownerPhone || store.getSetting('last_linked_number', '');
  if (!phone) return;
  try {
    const code = await sock.requestPairingCode(phone);
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

// Baileys reports your LID as either a full jid ("1207...@lid") or a bare
// number straight from the CB:success node. jidNormalizedUser() returns '' for
// a bare number, so normalize it to a proper "@lid" jid first.
function normalizeLid(lid) {
  if (!lid) return '';
  const s = String(lid).trim();
  if (!s) return '';
  return jidNormalizedUser(s.includes('@') ? s : s + '@lid');
}

function recordConnection() {
  const user = currentSock?.user;
  const jid = user?.id ? jidNormalizedUser(user.id) : '';
  const number = jid.split('@')[0] || jid;
  // WhatsApp addresses your own "Message yourself" thread by your LID (@lid)
  // rather than your phone jid, so keep it around for self-chat detection.
  const lid = user?.lid ? normalizeLid(user.lid) : '';
  if (lid) session.setState({ lid });
  const device = deviceName(user?.device) + ' · macOS Chrome';
  session.setDeviceInfo({
    number,
    lid,
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
    // WhatsApp rejects connections that report an outdated Web version with
    // status 405 ("Connection Failure"). Fetch the current version at startup
    // (as Baileys' docs recommend) so the registration/pairing handshake
    // passes, instead of pinning a hardcoded number that WhatsApp later rolls
    // past. Falls back to the last-known-good version if the check fails.
    version: await resolveWAVersion(),
    browser: Browsers.macOS('Chrome'),
    logger: baileysLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => store.getRaw(key.id) || { conversation: '' },
  });
  currentSock = sock;
  session.setSocket(sock);
  session.setState({ connection: 'connecting', connected: false });

  // Quick wins background jobs: fire due reminders and the 7am daily rundown.
  reminders.startLoop();
  quick.startDaily();

  // Wrap sendMessage so every outgoing message id is recorded. Baileys echoes
  // the session's own sends back through messages.upsert with fromMe = true;
  // recorded ids let the router distinguish bot replies from real owner texts.
  const _origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const res = await _origSend(...args);
    session.markSent(res?.key?.id || res?.id);
    return res;
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.setQr(qr);
      // Always try pairing code first — use env phone, persisted phone, or any
      // known number. Only fall back to QR print if we truly have nothing.
      const phone = config.ownerPhone || store.getSetting('last_linked_number', '');
      if (phone) {
        await tryPairingCode(sock, phone);
        return;
      }
      printQR(qr);
    }

    if (connection === 'open') {
      pairingRequested = false;
      recordConnection();
      // Persist the linked number so relink can always request a pairing code
      // even after wiping the session.
      if (sock.user?.id) {
        const num = String(sock.user.id.split('@')[0] || '').replace(/\D/g, '');
        if (num) store.setSetting('last_linked_number', num);
      }
      logger.info(`Connected as ${session.getState().number}`);
      contacts.sync(sock).then((n) => session.setState({ contacts: n })).catch(() => {});
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      session.setState({ connection: 'closed', connected: false });
      if (code === DisconnectReason.loggedOut || code === 405) {
        logger.error(`Session rejected (code ${code}). Use the dashboard "Re-link" button to reconnect.`);
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
  if (!session.getState().lid && sock.user?.lid) {
    try {
      session.setState({ lid: normalizeLid(sock.user.lid) });
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
  const delay = code === 408 ? 15000 : 3000;
  logger.info(`Restarting in ${delay / 1000}s…`);
  await sleep(delay);
  const old = currentSock;
  if (old) {
    try { old.end(); } catch (e) {}
    currentSock = null;
    session.setSocket(null);
  }
  try {
    await startBot();
  } catch (e) {
    logger.error('restart failed:', e.message);
  }
  restarting = false;
}

// Dashboard "Re-link" button: back up the session, log out, wipe it, and
// start fresh so a new pairing code/QR is produced for WhatsApp.
async function relink(phone) {
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
  session.setSocket(null);
  if (sock) {
    try {
      // logout() can hang forever on an already-dead session (e.g. after a
      // 405 rejection). Never let it block the relink.
      await Promise.race([sock.logout().catch(() => {}), sleep(3000)]);
    } catch (e) {
      logger.warn('logout failed:', e.message);
    }
    try { sock.end(); } catch (e) {}
  }

  // Persist the phone number for pairing code generation.
  const pairingPhone = (phone || '').replace(/\D/g, '') || store.getSetting('last_linked_number', '') || config.ownerPhone || '';
  if (pairingPhone) store.setSetting('last_linked_number', pairingPhone);

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

  // Poll until a pairing code OR QR is ready, so the dashboard always has
  // something to show. Fall back to whatever state we have after the window.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const s = session.getState();
    if (s.pairingCode || s.qr) {
      session.setState({ relinkPending: false });
      return { ok: true, code: s.pairingCode, qr: s.qr || '', number: pairingPhone };
    }
    await sleep(500);
  }
  session.setState({ relinkPending: false });
  const s = session.getState();
  return { ok: true, code: s.pairingCode, qr: s.qr || '', number: pairingPhone };
}

module.exports = { startBot, relink, deviceName };