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

  // EOCD must be found scanning BACKWARDS from the end (max 65557 bytes back).
  // Using indexOf() breaks on archives whose compressed data happens to
  // contain the 0x50 0x4b 0x05 0x06 byte pattern before the real EOCD.
  const sigEocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let end = -1;
  const scanStart = Math.max(0, b.length - 65557);
  for (let i = b.length - 22; i >= Math.max(scanStart, 0); i--) {
    if (b[i] === sigEocd[0] && b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');

  let count = b.readUInt16LE(end + 10);
  let cd = b.readUInt32LE(end + 16);
  let cdSize = b.readUInt32LE(end + 12);

  // ZIP64? The locator always sits 20 bytes before the EOCD record.
  const needZip64 = count === 0xffff || cd === 0xffffffff || cdSize === 0xffffffff;
  if (needZip64) {
    const loc = end - 20;
    if (loc >= 0 && b.readUInt32LE(loc) === 0x07064b50) {
      const z64 = b.readUInt32LE(loc + 8);
      if (b.readUInt32LE(z64) === 0x06064b50) {
        const total = b.readBigUInt64LE(z64 + 32);
        const cdOff = b.readBigUInt64LE(z64 + 48);
        if (total <= BigInt(Number.MAX_SAFE_INTEGER)) count = Number(total);
        if (cdOff <= BigInt(Number.MAX_SAFE_INTEGER)) cd = Number(cdOff);
      }
    }
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (cd < 0 || cd + 46 > b.length) throw new Error('bad zip central directory');
    if (b.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad zip central directory');

    const method = b.readUInt16LE(cd + 10);
    let compSize = b.readUInt32LE(cd + 20);
    let nameLen = b.readUInt16LE(cd + 28);
    const extraLen = b.readUInt16LE(cd + 30);
    const commentLen = b.readUInt16LE(cd + 32);
    let lho = b.readUInt32LE(cd + 42);

    // ZIP64 sizes/offsets live in the per-entry extra field (tag 0x0001).
    // Standard field order: uncompressed(8), compressed(8), local-header-offset(8).
    if (compSize === 0xffffffff || lho === 0xffffffff) {
      let ex = cd + 46 + nameLen;
      const exEnd = ex + extraLen;
      while (ex + 4 <= exEnd) {
        const tag = b.readUInt16LE(ex);
        const sz = b.readUInt16LE(ex + 2);
        if (tag === 0x0001) {
          let o = ex + 4;
          if (compSize === 0xffffffff || lho === 0xffffffff) {
            if (o + 8 <= exEnd) o += 8; // skip uncompressed size
            if (compSize === 0xffffffff && o + 8 <= exEnd) { compSize = Number(b.readBigUInt64LE(o)); o += 8; }
            if (lho === 0xffffffff && o + 8 <= exEnd) { lho = Number(b.readBigUInt64LE(o)); o += 8; }
          }
          break;
        }
        ex += 4 + sz;
      }
    }

    const name = b
      .toString('utf8', cd + 46, cd + 46 + nameLen)
      .replace(/^.*[\/\\]/, '');
    if (/\/$/.test(name)) { cd += 46 + nameLen + extraLen + commentLen; continue; } // directory entry

    if (lho < 0 || lho + 30 > b.length) throw new Error('bad zip local header');
    const lname = b.readUInt16LE(lho + 26);
    const lextra = b.readUInt16LE(lho + 28);
    const start = lho + 30 + lname + lextra;
    const data = b.subarray(start, start + compSize);
    if (data.length !== compSize) throw new Error('zip data truncated');

    let text = '';
    try {
      if (method === 0) text = data.toString('utf8');
      else if (method === 8) text = zlib.inflateRawSync(data).toString('utf8');
      else throw new Error(`untracked zip entry: ${name}`);
    } catch (e) {
      throw new Error(`zip entry "${name}" could not be read (${method}): ${e.message}`);
    }
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