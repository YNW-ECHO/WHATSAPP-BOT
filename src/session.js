const { typingDelay, sleep } = require('./human');

let sock = null;
const hot = new Map();
const pendingCommands = new Map();
const state = {
  connection: 'connecting',
  connected: false,
  contacts: 0,
  number: '',
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
  pendingCommands.set(jid, data);
}

function clearPending(jid) {
  pendingCommands.delete(jid);
}

function pendingFor(jid) {
  return pendingCommands.get(jid) || null;
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
  simulateTyping,
  stopTyping,
};