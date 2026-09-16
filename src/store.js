const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

let db = null;
const rawCache = new Map();

function init() {
  if (db) return db;
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
      kind TEXT NOT NULL,            -- 'voice_command' | 'send' | 'status_view' | 'reply' | 'chat_command' | 'reaction'
      detail TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'whatsapp',  -- 'whatsapp' (linked device) | 'dashboard' (admin login)
      number TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      fact TEXT NOT NULL DEFAULT '',
      hits INTEGER NOT NULL DEFAULT 1,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summaries (
      jid TEXT PRIMARY KEY,
      summary TEXT NOT NULL DEFAULT '',
      last_history_id INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_memory (
      name TEXT PRIMARY KEY,
      display TEXT NOT NULL DEFAULT '',
      jid TEXT NOT NULL DEFAULT '',
      digits TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL DEFAULT '',
      due_at INTEGER NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      schedule TEXT NOT NULL DEFAULT '',
      recurring INTEGER NOT NULL DEFAULT 0,
      recipient_jid TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL DEFAULT '',
      song TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ad_impressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      jid TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS broadcast_out (
      jid TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS broadcast_drafts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);

  // migrate older DBs (reminders existed without recurring/schedule/recipient/song)
  try {
    const remCols = db.prepare('PRAGMA table_info(reminders)').all().map((c) => c.name);
    if (!remCols.includes('recurring')) {
      db.exec('ALTER TABLE reminders ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0');
    }
    if (!remCols.includes('schedule')) {
      db.exec("ALTER TABLE reminders ADD COLUMN schedule TEXT NOT NULL DEFAULT ''");
    }
    if (!remCols.includes('recipient_jid')) {
      db.exec("ALTER TABLE reminders ADD COLUMN recipient_jid TEXT NOT NULL DEFAULT ''");
    }
    if (!remCols.includes('recipient_name')) {
      db.exec("ALTER TABLE reminders ADD COLUMN recipient_name TEXT NOT NULL DEFAULT ''");
    }
    if (!remCols.includes('song')) {
      db.exec("ALTER TABLE reminders ADD COLUMN song TEXT NOT NULL DEFAULT ''");
    }
  } catch (e) {}
}

function getChat(jid) {
  let row = db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid);
  if (!row) {
    db.prepare('INSERT INTO chats (jid, auto_reply) VALUES (?, ?)').run(jid, config.autoReplyDefault ? 1 : 0);
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
    .prepare('SELECT role, text, ts FROM history WHERE jid = ? ORDER BY id DESC LIMIT ?')
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
  if (!db) return 0;
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
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return;
  const dup = db.prepare('SELECT id FROM style_samples WHERE lower(text) = ?').get(t.toLowerCase());
  if (dup) return;
  db.prepare('INSERT INTO style_samples (jid, text, ts) VALUES (?, ?, ?)').run(jid, t, Date.now());
}

function getStyleSamples(limit = 30) {
  return db
    .prepare('SELECT id, jid, text, ts FROM style_samples ORDER BY RANDOM() LIMIT ?')
    .all(limit);
}

function deleteStyleSample(id) {
  return db.prepare('DELETE FROM style_samples WHERE id = ?').run(id);
}

function clearStyleSamples() {
  return db.prepare('DELETE FROM style_samples').run();
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

// ---- ad impressions (sponsor slot reach) ----

function addAdImpression(jid = '') {
  db.prepare('INSERT INTO ad_impressions (ts, jid) VALUES (?, ?)').run(Date.now(), String(jid || ''));
}

function clearAdImpressions() {
  db.prepare('DELETE FROM ad_impressions').run();
}

function adImpressionStats() {
  const now = Date.now();
  const dayStart = now - (now % 86400000);
  const weekStart = dayStart - 6 * 86400000;
  const total = db.prepare('SELECT COUNT(*) AS n FROM ad_impressions').get().n;
  const today = db.prepare('SELECT COUNT(*) AS n FROM ad_impressions WHERE ts >= ?').get(dayStart).n;
  const week = db.prepare('SELECT COUNT(*) AS n FROM ad_impressions WHERE ts >= ?').get(weekStart).n;
  const dayMap = new Map();
  for (const r of db.prepare('SELECT ts FROM ad_impressions WHERE ts >= ?').all(weekStart)) {
    const d = new Date(r.ts).toISOString().slice(0, 10);
    dayMap.set(d, (dayMap.get(d) || 0) + 1);
  }
  const days = [...dayMap.entries()]
    .map(([day, n]) => ({ day, n }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  return { total, today, week, days };
}

// ---- broadcast opt-outs ----

function setOptOut(jid, on) {
  if (on) db.prepare('INSERT INTO broadcast_out (jid, ts) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET ts = excluded.ts').run(String(jid), Date.now());
  else db.prepare('DELETE FROM broadcast_out WHERE jid = ?').run(String(jid));
}

function isOptedOut(jid) {
  return !!db.prepare('SELECT 1 FROM broadcast_out WHERE jid = ?').get(String(jid));
}

function optedOutList() {
  return db.prepare('SELECT jid, ts FROM broadcast_out ORDER BY ts DESC').all();
}

// ---- broadcast drafts ----

const DRAFT_MAX = 20;

function addDraft(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  db.prepare('DELETE FROM broadcast_drafts WHERE id NOT IN (SELECT id FROM broadcast_drafts ORDER BY ts DESC LIMIT ?)').run(DRAFT_MAX - 1);
  const id = String(Date.now());
  db.prepare('INSERT INTO broadcast_drafts (id, text, ts) VALUES (?, ?, ?)').run(id, t, Date.now());
  return id;
}

function removeDraft(id) {
  db.prepare('DELETE FROM broadcast_drafts WHERE id = ?').run(String(id));
}

function listDrafts() {
  return db.prepare('SELECT id, text, ts FROM broadcast_drafts ORDER BY ts DESC').all();
}

function addDeviceLogin(d) {
  db.prepare(
    'INSERT INTO device_logins (kind, number, device, ip, location, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    d.kind || 'whatsapp',
    String(d.number || '').slice(0, 80),
    String(d.device || '').slice(0, 120),
    String(d.ip || '').slice(0, 60),
    String(d.location || '').slice(0, 160),
    String(d.detail || '').slice(0, 300),
    d.ts || Date.now()
  );
  db.prepare('DELETE FROM device_logins WHERE id NOT IN (SELECT id FROM device_logins ORDER BY id DESC LIMIT 500)').run();
}

function getDeviceLogins(limit = 100) {
  return db
    .prepare('SELECT * FROM device_logins ORDER BY id DESC LIMIT ?')
    .all(limit);
}

function clearDeviceLogins() {
  return db.prepare('DELETE FROM device_logins').run();
}

/* ---- knowledge base (facts) ---- */

function addFact(jid, subject, fact) {
  const s = String(subject || '').trim().slice(0, 60);
  const f = String(fact || '').trim().slice(0, 400);
  if (!s || !f) return null;
  const ex = db
    .prepare('SELECT id FROM facts WHERE lower(subject) = lower(?) AND lower(fact) = lower(?)')
    .get(s, f);
  if (ex) {
    db.prepare('UPDATE facts SET hits = hits + 1, ts = ? WHERE id = ?').run(Date.now(), ex.id);
    return { id: ex.id, hits: db.prepare('SELECT hits FROM facts WHERE id = ?').get(ex.id).hits, created: false };
  }
  const r = db
    .prepare('INSERT INTO facts (jid, subject, fact, hits, ts) VALUES (?, ?, ?, 1, ?)')
    .run(jid, s, f, Date.now());
  const count = db.prepare('SELECT COUNT(*) AS c FROM facts').get().c;
  if (count > 300) {
    db.prepare('DELETE FROM facts WHERE id NOT IN (SELECT id FROM facts ORDER BY hits DESC, ts DESC LIMIT ?)').run(300);
  }
  return { id: Number(r.lastInsertRowid), hits: 1, created: true };
}

function getFacts(limit = 100) {
  return db.prepare('SELECT * FROM facts ORDER BY hits DESC, ts DESC LIMIT ?').all(limit);
}

function factsForPrompt(limit = 8) {
  return db
    .prepare('SELECT subject, fact FROM facts ORDER BY hits DESC, ts DESC LIMIT ?')
    .all(limit)
    .map((r) => `- ${r.subject}: ${r.fact}`)
    .join('\n');
}

function deleteFact(id) {
  return db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}

function clearFacts() {
  return db.prepare('DELETE FROM facts').run();
}

/* ---- rolling conversation memory (summaries) ---- */

function getSummary(jid) {
  return db.prepare('SELECT * FROM summaries WHERE jid = ?').get(jid) || null;
}

function saveSummary(jid, summary, lastHistoryId) {
  db.prepare(
    'INSERT INTO summaries (jid, summary, last_history_id, ts) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(jid) DO UPDATE SET summary = excluded.summary, last_history_id = excluded.last_history_id, ts = excluded.ts'
  ).run(jid, String(summary || '').slice(0, 2000), lastHistoryId || 0, Date.now());
}

function getSummaries(limit = 200) {
  return db
    .prepare(
      `SELECT s.jid, s.summary, s.last_history_id, s.ts,
              COALESCE(c.name, '') AS name
       FROM summaries s LEFT JOIN contacts c ON c.jid = s.jid
       ORDER BY s.ts DESC LIMIT ?`
    )
    .all(limit);
}

function deleteSummary(jid) {
  return db.prepare('DELETE FROM summaries WHERE jid = ?').run(jid || '');
}

function clearSummaries() {
  return db.prepare('DELETE FROM summaries').run();
}

/* ---- imported person memory (remembered before they chat) ---- */

function digitsVariants(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (d.length < 9) return [];
  return [...new Set([d, d.slice(-9), d.slice(-10), d.replace(/^0+/, '')].filter((x) => x.length >= 9))];
}

function savePersonMemory(name, display, jid, digits, summary) {
  db.prepare(
    'INSERT INTO person_memory (name, display, jid, digits, summary, ts) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(name) DO UPDATE SET display = excluded.display, jid = excluded.jid, digits = excluded.digits, summary = excluded.summary, ts = excluded.ts'
  ).run(
    String(name).toLowerCase().slice(0, 120),
    String(display || '').slice(0, 120),
    String(jid || '').slice(0, 120),
    String(digits || '').slice(0, 40),
    String(summary || '').slice(0, 2000),
    Date.now()
  );
}

function getPersonMemoryByName(name) {
  const key = String(name || '').toLowerCase().trim();
  if (!key) return null;
  const exact = db.prepare('SELECT * FROM person_memory WHERE name = ?').get(key);
  if (exact) return exact;
  const vars = digitsVariants(key);
  if (!vars.length) return null;
  // phone-style matching: query digits can be local, stored digits international (or vice versa)
  const rows = db.prepare('SELECT * FROM person_memory').all();
  for (const r of rows) {
    const st = r.digits || '';
    if (!st) continue;
    if (vars.some((v) => st.endsWith(v) || v.endsWith(st))) return r;
  }
  return null;
}

function linkPersonMemory(name, jid) {
  db.prepare('UPDATE person_memory SET jid = ?, ts = ? WHERE name = ?').run(
    String(jid || ''), Date.now(), String(name).toLowerCase().slice(0, 120)
  );
}

function getContactName(jid) {
  const row = db.prepare('SELECT name FROM contacts WHERE jid = ?').get(jid);
  return row ? row.name : '';
}

function maxHistoryId(jid) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM history WHERE jid = ?').get(jid).m;
}

function countHistorySince(jid, sinceId) {
  return db.prepare('SELECT COUNT(*) AS c FROM history WHERE jid = ? AND id > ?').get(jid, sinceId || 0).c;
}

/* ---- reminders (persisted so they survive restarts) ---- */

function addReminder(text, dueAt, schedule, recurring, recipientJid, recipientName, song) {
  const r = db
    .prepare(
      'INSERT INTO reminders (text, due_at, sent, schedule, recurring, recipient_jid, recipient_name, song, ts) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(text || '').slice(0, 500),
      Math.max(Date.now(), Number(dueAt) || 0),
      String(schedule || ''),
      recurring ? 1 : 0,
      String(recipientJid || ''),
      String(recipientName || ''),
      String(song || ''),
      Date.now()
    );
  db.prepare('DELETE FROM reminders WHERE id NOT IN (SELECT id FROM reminders ORDER BY id DESC LIMIT 200)').run();
  return Number(r.lastInsertRowid);
}

function getDueReminders(now) {
  return db.prepare('SELECT * FROM reminders WHERE sent = 0 AND due_at <= ? ORDER BY due_at ASC LIMIT 20').all(now || Date.now());
}

function getReminders() {
  return db.prepare('SELECT * FROM reminders WHERE sent = 0 ORDER BY due_at ASC LIMIT 200').all();
}

function countPendingReminders() {
  return db.prepare('SELECT COUNT(*) AS c FROM reminders WHERE sent = 0').get().c;
}

function markReminderSent(id) {
  db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id);
}

function updateReminderNext(id, dueAt) {
  db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(Math.max(Date.now(), Number(dueAt) || Date.now()), id);
}

function deleteReminder(id) {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
}

module.exports = {
  addAdImpression,
  adImpressionStats,
  clearAdImpressions,
  addCommandLog,
  addDeviceLogin,
  addFact,
  addHistory,
  addReminder,
  addStyleSample,
  addVoiceLog,
  clearDeviceLogins,
  clearFacts,
  clearStyleSamples,
  clearSummaries,
  conversationRows,
  countCommandLogsToday,
  countContacts,
  countHistorySince,
  countPendingReminders,
  deleteFact,
  deleteReminder,
  deleteStyleSample,
  deleteSummary,
  factsForPrompt,
  getChat,
  getCommandLogs,
  getContactName,
  getContacts,
  getDeviceLogins,
  getDueReminders,
  getFacts,
  getHistory,
  getPersonMemoryByName,
  getRaw,
  getReminders,
  getSetting,
  getStyleSamples,
  getSummaries,
  getSummary,
  getVoiceLogs,
  init,
  isGlobalPaused,
  isOptedOut,
  linkPersonMemory,
  markReminderSent,
  optedOutList,
  setOptOut,
  addDraft,
  removeDraft,
  listDrafts,
  updateReminderNext,
  maxHistoryId,
  overviewStats,
  saveContact,
  savePersonMemory,
  saveRaw,
  saveSummary,
  setAutoReply,
  setLastSent,
  setMuted,
  setReplyMode,
  setSetting,
};
