const logger = require('./logger');
const store = require('./store');

async function sync(sock) {
  try {
    const map = await sock.fetchContacts();
    let n = 0;
    for (const [jid, c] of Object.entries(map || {})) {
      if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;
      const name = c.name || c.notify || c.verifiedName || '';
      if (name && name.trim()) {
        store.saveContact(jid, name.trim());
        n++;
      }
    }
    logger.info(`contacts synced: ${n}`);
    return n;
  } catch (e) {
    logger.warn('contacts sync failed:', e.message);
    return 0;
  }
}

function search(q) {
  const list = store.getContacts();
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const parts = query.split(/\s+/).filter(Boolean).map((p) => p.replace(/[^a-z0-9]/g, ''));
  if (!parts.length) return [];
  const qNorm = parts.join('');
  const scored = [];

  for (const c of list) {
    const nm = (c.name || '').toLowerCase();
    const nNorm = nm.replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (nNorm === qNorm) score = 1;
    else if (nNorm.includes(qNorm) || qNorm.includes(nNorm)) score = 0.9;
    else {
      const nameParts = nm.split(/\s+/).map((p) => p.replace(/[^a-z0-9]/g, ''));
      let hits = 0;
      for (const p of parts) {
        if (nameParts.some((x) => x.startsWith(p) || p.startsWith(x) || x.includes(p) || p.includes(x))) hits++;
      }
      score = hits / parts.length;
    }
    if (score > 0) scored.push({ jid: c.jid, name: c.name, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

module.exports = { sync, search };