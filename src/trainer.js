const zlib = require('zlib');
const store = require('./store');

// Parses a WhatsApp exported chat (.txt) and returns the ADMIN's own messages
// so they can be fed to the AI as few-shot style training data. Also returns
// every message so the import pipeline can extract facts / person memory.
//
// Supports the two WhatsApp export variants:
//   [9/12/26, 4:00:00 PM] Chris: niaje sasa?
//   9/12/26, 4:00 PM - Chris: niaje sasa?
// Multi-line messages continue on lines without the timestamp prefix.
function parseWhatsAppExport(raw, ownerHandle) {
  const allowed = normalizeTokens(ownerHandle);
  const lines = String(raw || '').split('\n');
  let cur = { sender: '', text: '' };
  const collected = [];
  const push = () => {
    if (cur.sender && cur.text.trim()) collected.push({ sender: cur.sender, text: cur.text.trim() });
    cur = { sender: '', text: '' };
  };

  const TS_RE =
    /^\s*\[?\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4},\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\s*(?:\]\s*(?:-\s*)?|-\s*)(\S.*)$/i;

  for (const line of lines) {
    const m = line.match(TS_RE);
    if (m) {
      const rest = m[1];
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
  let skipped = 0;
  const texts = [];
  const msgs = [];
  const otherCounts = new Map();

  for (const c of collected) {
    const st = normalizeTokens(c.sender);
    const isOwner = st.length && ownerTokens.length && ownerTokens.some((t) => st.includes(t)) && c.sender !== 'System';
    const t = cleanText(c.text);
    if (isOwner) {
      if (!t || t.length < 2 || t.length > 2000) continue;
      texts.push(t);
      msgs.push({ sender: c.sender, isOwner: true, text: t });
      matched++;
    } else {
      skipped++;
      if (c.sender !== 'System') {
        otherCounts.set(c.sender, (otherCounts.get(c.sender) || 0) + 1);
      }
      if (t) msgs.push({ sender: c.sender, isOwner: false, text: t.slice(0, 2000) });
    }
  }

  const otherLabels = [...otherCounts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  return { matched, texts, skipped, msgs, otherLabels };
}

// Clean a message while KEEPING emojis and punctuation (style signal):
// drops only WhatsApp media/formatting placeholders and pure link lines.
function cleanText(t) {
  return String(t || '')
    .replace(/<Media omitted>/gi, '')
    .replace(/<.*?>/g, '')
    .replace(/^https?:\/\/\S+$/gim, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
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

/* ---- lightweight pure-JS zip reader (no native deps) ---- */

function parseZipEntries(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const end = b.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // EOCD record
  if (end < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(end + 10);
  let cd = b.readUInt32LE(end + 16);
  if (cd === 0xffffffff) throw new Error('zip64 archives not supported');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = b.readUInt16LE(cd + 10);
    const compSize = b.readUInt32LE(cd + 20);
    const nameLen = b.readUInt16LE(cd + 28);
    const extraLen = b.readUInt16LE(cd + 30);
    const commentLen = b.readUInt16LE(cd + 32);
    const lho = b.readUInt32LE(cd + 42);
    const name = b.toString('utf8', cd + 46, cd + 46 + nameLen).replace(/^.*[\/\\]/, '');
    const lname = b.readUInt16LE(lho + 26);
    const lextra = b.readUInt16LE(lho + 28);
    const data = b.subarray(lho + 30 + lname + lextra, lho + 30 + lname + lextra + compSize);
    let text = '';
    if (method === 0) text = data.toString('utf8');
    else if (method === 8) text = zlib.inflateRawSync(data).toString('utf8');
    else throw new Error(`unsupported zip method ${method}`);
    entries.push({ name, text });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipTextFiles(buf) {
  return parseZipEntries(buf).filter((e) => /\.txt$/i.test(e.name));
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

module.exports = {
  parseWhatsAppExport,
  parseZipEntries,
  readZipTextFiles,
  importExport,
  addManual,
  normalizeTokens,
  cleanText,
};