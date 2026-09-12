const store = require('./store');

// Parses a WhatsApp exported chat (.txt) and returns the ADMIN's own messages
// so they can be fed to the AI as few-shot style training data.
//
// Export format (WhatsApp > Chat > Export chat > Without media):
//   [9/12/26, 4:00:00 PM] Chris: niaje sasa?
//   [9/12/26, 4:02:10 PM] +254 712 345 678: sawa boss
// Multi-line messages continue on lines without the "[date]" prefix.
function parseWhatsAppExport(raw, ownerHandle) {
  const allowed = normalizeTokens(ownerHandle);
  if (!allowed.length) return { matched: 0, texts: [], skipped: 0 };

  const lines = String(raw || '').split('\n');
  let cur = { sender: '', text: '' };
  const collected = [];
  let skipped = 0;

  const push = () => {
    if (cur.sender && cur.text.trim()) collected.push({ sender: cur.sender, text: cur.text.trim() });
    cur = { sender: '', text: '' };
  };

  for (const line of lines) {
    const m = line.match(
      /^\[(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\]\s*(.*)$/
    );
    if (m) {
      const rest = m[2];
      const colon = rest.indexOf(':');
      const sender = colon >= 0 ? rest.slice(0, colon).trim() : '';
      const text = colon >= 0 ? rest.slice(colon + 1).trim() : '';
      if (sender) {
        push();
        cur = { sender, text };
      } else if (cur.sender) {
        cur.text += ' ' + rest.trim();
      }
      continue;
    }
    // continuation line of a long message, or a flag line like <Media omitted>
    if (cur.sender && line.trim()) cur.text += ' ' + line.trim();
  }
  push();

  const ownerTokens = normalizeTokens(ownerHandle);
  let matched = 0;
  const texts = [];
  for (const c of collected) {
    const st = normalizeTokens(c.sender);
    const isOwner = st.length && ownerTokens.some((t) => st.includes(t)) && c.sender !== 'System';
    if (!isOwner) {
      skipped++;
      continue;
    }
    const t = c.text
      .replace(/<Media omitted>/gi, '')
      .replace(/<.*?>|<Media.*>/gi, '')
      .replace(/^https?:\/\/\S+$/gi, '')
      .trim();
    if (!t || t.length < 2 || t.length > 2000) continue;
    texts.push(t);
    matched++;
  }
  return { matched, texts, skipped };
}

function normalizeTokens(s) {
  const clean = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = clean.split(' ');
  const digits = clean.replace(/\D/g, '');
  const parts = tokens.filter(Boolean);
  if (digits.length >= 9) parts.push(digits, digits.slice(-9), digits.slice(-10), digits.replace(/^0+/, ''));
  return [...new Set(parts)];
}

function importExport(raw, ownerHandle, jid = '') {
  const { matched, texts, skipped } = parseWhatsAppExport(raw, ownerHandle);
  for (const t of texts) store.addStyleSample(jid || 'training', t);
  return { matched, skipped, added: texts.length };
}

function addManual(text, jid = '') {
  const t = String(text || '').trim();
  if (!t) return 0;
  store.addStyleSample(jid || 'manual', t.slice(0, 2000));
  return 1;
}

module.exports = { parseWhatsAppExport, importExport, addManual, normalizeTokens };