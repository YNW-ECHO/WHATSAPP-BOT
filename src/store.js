const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;
const rawCache = new Map();

function init() {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, 'bot.db'));
  db.pragma('journal_mode = WAL');

  // migration: add reply_mode, tone to existing chats tables
  try { db.exec("ALTER TABLE chats ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'text'"); } catch (e) {}
  try { db.exec("ALTER TABLE chats ADD COLUMN tone TEXT NOT NULL DEFAULT ''"); } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      auto_reply INTEGER NOT NULL DEFAULT 1,
      muted INTEGER NOT NULL DEFAULT 0,
      reply_mode TEXT NOT NULL DEFAULT 'text',
      tone TEXT NOT NULL DEFAULT '',
      last_sent_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS style_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      direction TEXT NOT NULL,      -- 'in' (received from contact) | 'out' (sent as voice reply)
      transcript TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      kind TEXT NOT NULL,            -- 'voice_command' | 'send' | 'status_view' | 'reply' | 'chat_command'
      detail TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
  `);
}

function getChat(jid) {
  let row = db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid);
  if (!row) {
    db.prepare('INSERT INTO chats (jid) VALUES (?)').run(jid);
    row = db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid);
  }
  return row;
}

function setAutoReply(jid, on) {
  db.prepare('UPDATE chats SET auto_reply = ? WHERE jid = ?').run(on ? 1 : 0, jid);
}

function setMuted(jid, on) {
  db.prepare('UPDATE chats SET muted = ? WHERE jid = ?').run(on ? 1 : 0, jid);
}

function setLastSent(jid, ts) {
  db.prepare('UPDATE chats SET last_sent_at = ? WHERE jid = ?').run(ts, jid);
}

function addHistory(jid, role, text) {
  db.prepare('INSERT INTO history (jid, role, text, ts) VALUES (?, ?, ?, ?)').run(
    jid,
    role,
    String(text || '').slice(0, 2000),
    Date.now()
  );
  db.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history WHERE jid = ? ORDER BY id DESC LIMIT 50)').run(jid);
}

function getHistory(jid, limit = 8) {
  return db
    .prepare('SELECT role, text FROM history WHERE jid = ? ORDER BY id DESC LIMIT ?')
    .all(jid, limit)
    .reverse();
}

function saveContact(jid, name) {
  db.prepare('INSERT INTO contacts (jid, name) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name').run(jid, name);
}

function getContacts() {
  return db.prepare('SELECT jid, name FROM contacts ORDER BY name ASC').all();
}

function countContacts() {
  return db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c;
}

function addVoiceLog(jid, direction, transcript) {
  db.prepare('INSERT INTO voice_logs (jid, direction, transcript, ts) VALUES (?, ?, ?, ?)').run(
    jid,
    direction,
    String(transcript || '').slice(0, 2000),
    Date.now()
  );
  db.prepare('DELETE FROM voice_logs WHERE id NOT IN (SELECT id FROM voice_logs ORDER BY id DESC LIMIT 500)').run();
}

function getVoiceLogs(limit = 50) {
  return db
    .prepare(
      `SELECT vl.jid, vl.direction, vl.transcript, vl.ts,
              COALESCE(c.name, '') AS name
       FROM voice_logs vl LEFT JOIN contacts c ON c.jid = vl.jid
       ORDER BY vl.id DESC LIMIT ?`
    )
    .all(limit);
}

function addCommandLog(jid, kind, detail) {
  db.prepare('INSERT INTO command_logs (jid, kind, detail, ts) VALUES (?, ?, ?, ?)').run(
    jid,
    kind,
    String(detail || '').slice(0, 500),
    Date.now()
  );
  db.prepare('DELETE FROM command_logs WHERE id NOT IN (SELECT id FROM command_logs ORDER BY id DESC LIMIT 500)').run();
}

function getCommandLogs(kind, limit = 100) {
  if (kind) {
    return db
      .prepare(
        `SELECT cl.jid, cl.kind, cl.detail, cl.ts,
                COALESCE(ct.name, '') AS name
         FROM command_logs cl LEFT JOIN contacts ct ON ct.jid = cl.jid
         WHERE cl.kind = ? ORDER BY cl.id DESC LIMIT ?`
      )
      .all(kind, limit);
  }
  return db
    .prepare(
      `SELECT cl.jid, cl.kind, cl.detail, cl.ts,
              COALESCE(ct.name, '') AS name
       FROM command_logs cl LEFT JOIN contacts ct ON ct.jid = cl.jid
       ORDER BY cl.id DESC LIMIT ?`
    )
    .all(limit);
}

function countCommandLogsToday(kind, dayStart = startOfDay()) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM command_logs WHERE kind = ? AND ts >= ?')
    .get(kind, dayStart).c;
}

function overviewStats() {
  const dayStart = startOfDay();
  const total = (() => {
    try { return db.prepare('SELECT COUNT(*) AS c FROM history WHERE role = ? AND ts >= ?').get('user', dayStart).c; } catch (e) { return 0; }
  })();
  const replies = (() => {
    try { return db.prepare('SELECT COUNT(*) AS c FROM history WHERE role = ? AND ts >= ?').get('assistant', dayStart).c; } catch (e) { return 0; }
  })();
  const activeChats = (() => {
    try {
      return db.prepare('SELECT COUNT(DISTINCT jid) AS c FROM history WHERE ts >= ?').get(dayStart).c;
    } catch (e) { return 0; }
  })();
  const voiceIn = countCommandLogsToday('voice_command', dayStart);
  const voiceCmds = (() => {
    try {
      return db.prepare('SELECT COUNT(*) AS c FROM voice_logs WHERE direction = ? AND ts >= ?').get('in', dayStart).c;
    } catch (e) { return 0; }
  })();
  const statuses = countCommandLogsToday('status_view', dayStart);
  return {
    total, replies, activeChats, voiceCmds, voiceCmdsCnt: voiceIn, statuses,
    contacts: countContacts(),
    uptime: ((Date.now() - startedAt) / 60000) | 0,
  };
}

function conversationRows() {
  return db
    .prepare(
      `SELECT c.jid,
              COALESCE(ct.name, '') AS name,
              c.auto_reply, c.muted, c.reply_mode, c.tone, c.last_sent_at,
              (SELECT role FROM history h WHERE h.jid = c.jid ORDER BY h.id DESC LIMIT 1) AS last_role,
              (SELECT text FROM history h WHERE h.jid = c.jid ORDER BY h.id DESC LIMIT 1) AS last_text,
              (SELECT ts FROM history h WHERE h.jid = c.jid ORDER BY h.id DESC LIMIT 1) AS last_ts,
              (SELECT COUNT(*) FROM history h WHERE h.jid = c.jid AND h.ts >= ?) AS msgs_today
       FROM chats c
       LEFT JOIN contacts ct ON ct.jid = c.jid
       ORDER BY last_ts DESC`
    )
    .all(startOfDay());
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

let startedAt = Date.now();

function saveRaw(id, message) {
  rawCache.set(id, message);
  if (rawCache.size > 3000) {
    rawCache.delete(rawCache.keys().next().value);
  }
}

function getRaw(id) {
  return rawCache.get(id);
}

function setReplyMode(jid, mode) {
  db.prepare('UPDATE chats SET reply_mode = ? WHERE jid = ?').run(mode, jid);
}

function addStyleSample(jid, text) {
  if (!text || !text.trim()) return;
  db.prepare('INSERT INTO style_samples (jid, text, ts) VALUES (?, ?, ?)').run(
    jid, text.trim().slice(0, 2000), Date.now()
  );
}

function getStyleSamples(limit = 30) {
  return db
    .prepare('SELECT id, jid, text, ts FROM style_samples ORDER BY RANDOM() LIMIT ?')
    .all(limit);
}

function getSetting(key, defaultVal = '') {
  const row = db.prepare('SELECT value FROM global_settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function isGlobalPaused() {
  return getSetting('global_pause', '0') === '1';
}

module.exports = {
  addCommandLog,
  addHistory,
  addStyleSample,
  addVoiceLog,
  conversationRows,
  countCommandLogsToday,
  countContacts,
  getChat,
  getCommandLogs,
  getContacts,
  getHistory,
  getRaw,
  getSetting,
  getStyleSamples,
  getVoiceLogs,
  init,
  isGlobalPaused,
  overviewStats,
  saveContact,
  saveRaw,
  setAutoReply,
  setLastSent,
  setMuted,
  setReplyMode,
  setSetting,
};
