const { typingDelay, sleep } = require('./human');

let sock = null;
const hot = new Map();
const pendingCommands = new Map();
const sentIds = new Set();
const PENDING_TTL = 10 * 60 * 1000; // a contact-confirmation menu goes stale in 10 min
const state = {
  connection: 'connecting',
  connected: false,
  contacts: 0,
  number: '',
  lid: '',
  device: '',
  pairingCode: '',
  qr: '',
  relinkPending: false,
  lastLoginAt: 0,
  startedAt: Date.now(),
};

function setSocket(s) {
  sock = s;
}

function getSocket() {
  return sock;
}

function setState(partial) {
  Object.assign(state, partial);
}

function getState() {
  return { ...state };
}

function setPairingCode(code) {
  state.pairingCode = code || '';
  state.relinkPending = false;
}

function setQr(qr) {
  state.qr = qr || '';
}

function setDeviceInfo(partial) {
  Object.assign(state, partial);
}

function markActive(jid) {
  hot.set(jid, Date.now());
}

function isHot(jid, windowMs) {
  const t = hot.get(jid);
  return !!t && Date.now() - t < windowMs;
}

function releaseHot(jid) {
  hot.delete(jid);
}

function setPending(jid, data) {
  pendingCommands.set(jid, { at: Date.now(), ...data });
}

function clearPending(jid) {
  pendingCommands.delete(jid);
}

function pendingFor(jid) {
  const p = pendingCommands.get(jid);
  if (!p) return null;
  // A stale menu must never be confirmed by a later, unrelated message.
  if (Date.now() - p.at > PENDING_TTL) {
    pendingCommands.delete(jid);
    return null;
  }
  return p;
}

// Remember message ids the bot itself sent (via sendMessage). Baileys echoes
// the session's own outgoing messages back through messages.upsert with
// key.fromMe = true, and we must NOT learn those as "owner style samples".
function markSent(id) {
  if (!id) return;
  sentIds.add(String(id));
  if (sentIds.size > 500) {
    const first = sentIds.keys().next().value;
    sentIds.delete(first);
  }
}

function isSelfSent(id) {
  return !!id && sentIds.has(String(id));
}

async function simulateTyping(jid, textLen) {
  try {
    if (sock) await sock.sendPresenceUpdate('composing', jid);
  } catch (e) {}
  await sleep(typingDelay(textLen));
}

async function stopTyping(jid) {
  try {
    if (sock) await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {}
}

module.exports = {
  setSocket,
  getSocket,
  setState,
  getState,
  setPairingCode,
  setQr,
  setDeviceInfo,
  markActive,
  isHot,
  releaseHot,
  setPending,
  clearPending,
  pendingFor,
  markSent,
  isSelfSent,
  simulateTyping,
  stopTyping,
};