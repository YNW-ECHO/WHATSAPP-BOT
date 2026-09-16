const logger = require('./logger');
const store = require('./store');
const session = require('./session');
const contacts = require('./contacts');
const songs = require('./songs');

// Natural-language reminders: "remind me in 30 min to call Mama",
// "remind Mama to buy milk at 5pm" (goes to Mama's chat), "remind me every
// Monday at 9am to pay rent", with an optional "with song <name> by <artist>"
// that plays as a voice-note notification when the reminder fires.
// Stored in SQLite so they survive restarts; a 15s loop fires anything due.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': '*/*',
};
const MAX_SONG = 15 * 1024 * 1024; // keep the song voice-note under WA's ceiling

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, wk: 604800000, week: 604800000, weeks: 604800000,
};

const IN_RE = /\bin\s+(\d+(?:\.?\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\b/i;
const AT_RE = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

// Nairobi is UTC+3 with no DST, so a Nairobi wall-clock instant at (y,m,d,h:min)
// equals a UTC clock reading of (y,m,d,h+3:min). We schedule in that shifted
// "UTC clock" so the math is pure UTC; the real epoch is 3h earlier.
const NAI_OFFSET = 3 * 3600 * 1000;

const WEEKDAY_NAMES = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const WEEKDAY_FLAGS = Object.keys(WEEKDAY_NAMES).sort((a, b) => WEEKDAY_NAMES[b] - WEEKDAY_NAMES[a]).join('|');

// Parses "at 9:30pm" (or "at 9") into {hr, min}, 24h.
function timeFromAt(text) {
  const m = text.match(AT_RE);
  if (!m) return null;
  let hr = parseInt(m[1], 10);
  let min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hr < 12) hr += 12;
  if (ap === 'am' && hr === 12) hr = 0;
  return { hr, min, raw: m[0] };
}

// Detects a repeating schedule inside the body. Returns a canonical schedule
// string "type|payload|hh:mm" or null.
function detectSchedule(body) {
  const lower = String(body || '').toLowerCase();
  const time = timeFromAt(body);
  if (!time) return null;

  const days = [];
  for (const name of Object.keys(WEEKDAY_NAMES)) {
    if (new RegExp(`\\b${name}(?:s)?\\b`, 'i').test(lower)) days.push(WEEKDAY_NAMES[name]);
  }
  const hm = `${String(time.hr).padStart(2, '0')}:${String(time.min).padStart(2, '0')}`;

  const monthDom = lower.match(/\bevery\s+(\d{1,2})(?:st|nd|rd|th)?\s+of(?:\s+the)?\s+month\b/);
  const hasMonthly = /\bmonthly\b/.test(lower) || !!monthDom;
  const hasWeekday = /\bweekdays?\b/.test(lower);
  const hasWeekend = /\bweekends?\b/.test(lower);
  const hasDaily = /\b(?:dayly|daily|everyday)\b/.test(lower) || /(^|\s)every\s+day\b/.test(lower);

  if (days.length) return { type: 'dow', payload: [...new Set(days)].sort((a, b) => a - b).join(','), hm };
  if (hasWeekday) return { type: 'dow', payload: '1,2,3,4,5', hm };
  if (hasWeekend) return { type: 'dow', payload: '0,6', hm };
  if (hasMonthly) {
    const dom = monthDom ? Math.min(31, Math.max(1, parseInt(monthDom[1], 10))) : 1;
    return { type: 'dom', payload: String(dom), hm };
  }
  if (hasDaily) return { type: 'day', payload: '', hm };
  return null;
}

// Next real epoch at which schedule fires, strictly after `after`.
function nextOccurrence(schedule, after = Date.now()) {
  const [type, payload, hm] = String(schedule || '').split('|');
  if (!hm) return after + 86400000;
  const [h, min] = hm.split(':').map(Number);
  const nums = (payload || '').split(',').map(Number).filter((n) => Number.isFinite(n));
  const afterClk = after + NAI_OFFSET;
  const base = new Date(afterClk);
  for (let i = 0; i < 400; i++) {
    const cand = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i, h, min, 0, 0));
    if (cand.getTime() <= afterClk) continue;
    let ok = false;
    if (type === 'day') ok = true;
    else if (type === 'dow') ok = nums.includes(cand.getUTCDay());
    else if (type === 'dom') ok = nums.includes(cand.getUTCDate());
    if (ok) return cand.getTime() - NAI_OFFSET;
  }
  return after + 86400000;
}

// "1,2,3,4,5" → "Mon–Fri" etc.
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function humanizeSchedule(schedule) {
  const [type, payload, hm] = String(schedule || '').split('|');
  const t = hm || '';
  if (type === 'day') return `every day at ${t}`;
  if (type === 'dow') {
    const ns = (payload || '').split(',').map(Number).sort((a, b) => a - b);
    if (!ns.length) return `every day at ${t}`;
    const run = (ns, i) => {
      let j = i;
      while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
      return j;
    };
    const parts = [];
    for (let i = 0; i < ns.length; i = run(ns, i) + 1) {
      const end = run(ns, i);
      parts.push(i === end ? DAY_SHORT[ns[i]] : `${DAY_SHORT[ns[i]]}–${DAY_SHORT[ns[end]]}`);
    }
    return `${parts.join(', ')} at ${t}`;
  }
  if (type === 'dom') return `on the ${payload}${ordinal(payload)} of the month at ${t}`;
  return `at ${t}`;
}

function ordinal(n) {
  const v = Number(n);
  if (v % 100 >= 11 && v % 100 <= 13) return 'th';
  const last = v % 10;
  if (last === 1) return 'st';
  if (last === 2) return 'nd';
  if (last === 3) return 'rd';
  return 'th';
}

function scrubScheduleWords(rest) {
  return rest
    .replace(new RegExp(`\\b(?:${WEEKDAY_FLAGS})\\w*`, 'gi'), ' ')
    .replace(/\bevery\s+day\b/gi, ' ')
    .replace(/\b(?:every|daily|everyday|weekly|monthly|weekdays?|weekends?)\b/gi, ' ')
    .replace(/\bthe\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+of(?:\s+the)?\s+month\b/gi, ' ')
    .replace(/\s+(?:and|or)\s+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:on\s+)?(?:to|about|for|me)\s+/i, '')
    .trim();
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RECIPIENT_STOP = /^(?:me|us|them|you|yourself|myself|himself|herself|reminder|a|an|the)$/i;

// Time/schedule phrase that may sit between the recipient's name and "to":
// "John in 10 min to …", "John at 9am to …", "John every Monday at 9am to …".
const TIME_FILL = /\b(?:in\s+(?:\d[\w .,:]*?)|at\s+(?:\d[a-z0-9.:]{0,12})|tomorrow(?:[\w .-]*?)|every(?:[\w .-]*?))\s+to\b/i;

// "remind John to …", "remind John in 10 min to …", "remind John every Mon at
// 9am to …", "remind 254712345678 to …". Returns the recipient (name/number)
// exactly as typed, or null.
function extractRecipient(body) {
  const s = String(body || '').trim();
  if (!s) return null;

  // Phone number directly before "to".
  let m = s.match(/^(\+?\d[\d\s+()\-]{7,20})\s+to\b/i);
  if (m) return m[1].replace(/[\s+()\-]/g, '').trim();

  // Name directly before "to".
  m = s.match(/^((?:[A-Za-z][A-Za-z.'\-]*\s*){1,3})to\b/i);

  // Otherwise: name, then a time/schedule phrase, then "to".
  if (!m) {
    const tm = s.match(TIME_FILL);
    if (tm && tm.index >= 2) {
      const head = s.slice(0, tm.index).replace(/[.,;\s]+$/g, '');
      if (/^[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*){0,2}$/.test(head)) m = [null, head];
    }
  }

  if (!m) return null;
  let name = m[1].trim();
  // Calendar noise can slip into the name with the tolerant pattern above.
  name = name
    .replace(/^(?:every|daily|weekly|monthly)\b/gi, ' ')
    .replace(new RegExp(`\\b(?:${WEEKDAY_FLAGS})\\w*`, 'gi'), ' ')
    .replace(/\b(?:everyday|day)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 40) return null;
  if (RECIPIENT_STOP.test(name)) return null;
  name = name.replace(/[.,;\s]+$/g, '');
  return name || null;
}

const SONG_RE = /\bwith\s+(?:the\s+)?(?:song|tune|track|music|audio|clip|ringtone|chime)\s+(.+)$/i;

// Extract "with song <name> by <artist>" from the remaining body.
function extractSong(rest) {
  const m = String(rest || '').match(SONG_RE);
  if (!m) return null;
  let q = m[1].replace(/[.,;!\s]+$/g, '').trim();
  if (q.replace(/[^a-z0-9]/gi, '').length < 3) return null;
  if (q.length > 200) q = q.slice(0, 200);
  return q;
}

function parseReminder(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(?:remind\s+me|remind|set\s+(?:a\s+)?reminder)[,:]?\s*(.*)$/i);
  if (!m) return null;

  // Recipient comes straight from the raw body (name/number valid answer to
  // "remind <whom> …"). "remind me …" never matches because there's no name
  // token before the "to".
  const recipient = extractRecipient(m[1]);

  let rest = m[1].replace(/\btomorrow\b/gi, ' TMRW');
  // Drop the recipient's name so it never leaks into the "what" text.
  if (recipient) rest = rest.replace(new RegExp('^' + escapeRegExp(recipient) + '\\b'), ' ');

  const schedule = detectSchedule(rest);

  let dueAt = null;
  const inM = rest.match(IN_RE);
  if (inM) {
    const mult = UNIT_MS[inM[2].toLowerCase()] || 60000;
    dueAt = Date.now() + Math.round(parseFloat(inM[1]) * mult);
    rest = rest.replace(inM[0], '');
  } else if (schedule) {
    dueAt = nextOccurrence(`${schedule.type}|${schedule.payload}|${schedule.hm}`, Date.now());
    const atM = rest.match(AT_RE);
    if (atM) rest = rest.replace(atM[0], '');
  } else {
    const atM = rest.match(AT_RE);
    if (atM) {
      const t2 = timeFromAt(atM[0]);
      const d = new Date();
      const hasTmr = /\bTMRW\b/i.test(rest);
      if (hasTmr) d.setDate(d.getDate() + 1);
      d.setHours(t2.hr, t2.min, 0, 0);
      if (d.getTime() <= Date.now() && !hasTmr) d.setDate(d.getDate() + 1);
      dueAt = d.getTime();
      rest = rest.replace(atM[0], '');
    }
  }

  if (!dueAt) return null;

  // Optional notification song — plain words, searched on YouTube via yt-search.
  const songQuery = extractSong(rest);
  if (songQuery) rest = rest.replace(SONG_RE, '');

  let what = rest
    .replace(/\bTMRW\b/gi, '')
    .replace(/^\s+/, '')
    .replace(/^(?:remind\s+me\s+)?(?:to|about|for|me)\s*/i, '');
  if (schedule) what = scrubScheduleWords(what);
  what = what.replace(/[.,!\s]+$/g, '').trim();
  if (!what) what = 'reminder';
  if (what.length > 300) what = what.slice(0, 300);

  if (schedule) {
    return {
      recurring: true,
      schedule: `${schedule.type}|${schedule.payload}|${schedule.hm}`,
      dueAt,
      what,
      recipient,
      songQuery, // may be undefined → column stays empty
    };
  }
  return { dueAt, what, recipient, songQuery };
}

function nairobiTime(ts) {
  try {
    return new Date(ts).toLocaleString('en-KE', {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Africa/Nairobi',
    });
  } catch (e) {
    return new Date(ts).toLocaleString();
  }
}

// Store the reminder and reply to the owner with a confirmation. Contacts are
// resolved here; the song (if any) is searched on YouTube so the owner is told
// right away whether it was recognized or to suggest another one.
async function create(sock, ownerJid, parsed) {
  // ---- resolve recipient (contact name or phone number) ----
  let recipientJid = '';
  let recipientName = '';
  let recipientNote = '';
  if (parsed.recipient) {
    const digits = String(parsed.recipient).replace(/\D/g, '');
    if (/^\d{9,15}$/.test(digits)) {
      const intl = digits.startsWith('0') ? '254' + digits.slice(1) : digits;
      recipientJid = intl + '@s.whatsapp.net';
      recipientName = parsed.recipient;
    } else {
      const hit = contacts.search(parsed.recipient)[0];
      if (hit && hit.score >= 0.5) {
        recipientJid = hit.jid;
        recipientName = hit.name || parsed.recipient;
      }
    }
    if (!recipientJid) {
      // Safe default: the reminder still goes to the owner, clearly explained,
      // so nothing is lost while they fix the contact name.
      recipientNote = `⚠️ I don't have a contact for "${parsed.recipient}" — I'll remind *you* instead. Add them, then say it again to send it to them.`;
    }
  }

  // ---- validate the notification song via the built-in YouTube search ----
  let songMatch = null;
  if (parsed.songQuery) {
    try {
      songMatch = await songs.searchSong(parsed.songQuery);
    } catch (e) {
      logger.warn('reminder song search failed:', e.message);
      songMatch = null;
    }
  }

  const id = store.addReminder(
    parsed.what,
    parsed.dueAt,
    parsed.recurring ? parsed.schedule : '',
    !!parsed.recurring,
    recipientJid,
    recipientName,
    songMatch ? parsed.songQuery : ''
  );

  const when = parsed.recurring
    ? `repeats ${humanizeSchedule(parsed.schedule)} (first ${nairobiTime(parsed.dueAt)})`
    : nairobiTime(parsed.dueAt);

  const lines = ['⏰ *Reminder set!*', `📌 ${parsed.what}`, `🔁 ${when}`];
  if (recipientJid) lines.push(`👤 will remind *${recipientName}*`);
  else if (recipientNote) lines.push(recipientNote);
  if (songMatch) {
    lines.push(
      `🎵 song: *${songMatch.title}*${songMatch.author ? ' by _' + songMatch.author + '_' : ''} — plays when it fires`
    );
  } else if (songMatch === null && parsed.songQuery) {
    lines.push(
      `🎵 Couldn't find a song matching "${parsed.songQuery}" — say the reminder again with another song, just the name + artist is fine.`
    );
  }
  lines.push(`(id ${id})`);

  try {
    await sock.sendMessage(ownerJid, { text: lines.join('\n') });
  } catch (e) {
    logger.warn('reminder confirm failed:', e.message);
  }
  store.addCommandLog(ownerJid, 'chat_command', `reminder set: ${parsed.what} @ ${when}`);
  logger.info(`reminder #${id} → ${when}: ${parsed.what}`);
  return true;
}

// List all pending (one-off + upcoming) reminders for the owner.
function listText() {
  const all = store.getReminders();
  if (!all.length) return '⏰ No reminders yet.\nTry "remind me in 30 min to call Mama", "remind John at 5pm to buy milk", or "remind me every Mon at 9am with song Legend by Bob Marley".';
  const lines = ['⏰ *Reminders*'];
  all.forEach((r, i) => {
    const when = r.recurring
      ? `repeats ${humanizeSchedule(r.schedule)}`
      : nairobiTime(r.due_at);
    const tags = [];
    if (r.recipient_name) tags.push(`👤 ${r.recipient_name}`);
    if (r.song) tags.push(`🎵 ${r.song}`);
    lines.push(`${i + 1}) ${r.text}\n   • 🔁 ${when}${tags.length ? ' · ' + tags.join(' · ') : ''} · id ${r.id}`);
  });
  lines.push('', 'Remove one: "cancel reminder <id>" or "!remind del <id>"');
  return lines.join('\n');
}

// "cancel reminder 3" / "!remind del 3" → delete from the store.
function removeByText(sock, jid, text) {
  const m = String(text || '').trim().match(
    /^(?:cancel|delete|remove|stop)\s+(?:the\s+)?(?:reminder|reminders)\s*(?:id)?\s*[:#]?\s*(\d+)/i
  ) || String(text || '').trim().match(/^!remind(?:er)?\s+del(?:ete)?\s*[:#]?\s*(\d+)/i);
  if (!m) return false;
  const id = parseInt(m[1], 10);
  const target = store.getReminders().find((r) => r.id === id);
  if (!target) {
    sock.sendMessage(jid, { text: `🤔 No reminder with id ${id}.` }).catch(() => {});
    return true;
  }
  store.deleteReminder(id);
  sock.sendMessage(jid, { text: `🗑️ Reminder ${id} removed: "${target.text}"` }).catch(() => {});
  return true;
}

let loopStarted = false;

function ownerSelfJid() {
  const num = String(session.getState().number || '').replace(/\D/g, '');
  return num ? num + '@s.whatsapp.net' : '';
}

// Fires any due reminders. Goes to the contact's chat when one was set, else
// the owner's own chat. If a notification song is attached it plays first as
// a voice note, then the text reminder follows. Repeating reminders are never
// "sent": their next occurrence is computed and stored instead.
async function fireDue(sock) {
  let fired = 0;
  const due = store.getDueReminders(Date.now());
  if (!due.length) return 0;
  const ownerJid = ownerSelfJid();
  if (!ownerJid) return 0;

  for (const r of due) {
    const targetJid = r.recipient_jid || ownerJid;
    try {
      // 1) Optional notification song → play it as a WhatsApp voice note.
      if (r.song) {
        let audio = null;
        let mime = 'audio/mpeg';
        try {
          if (/^https?:\/\//i.test(r.song)) {
            const res = await fetch(r.song, { headers: UA, signal: AbortSignal.timeout(30000), redirect: 'follow' });
            const buf = Buffer.from(await res.arrayBuffer());
            try {
              audio = await songs.bufferToOpusOgg(buf);
              mime = 'audio/ogg; codecs=opus';
            } catch (e) {
              audio = buf;
              mime = String(res.headers.get('content-type') || 'audio/mpeg');
            }
          } else {
            const found = await songs.searchSong(r.song);
            if (found && found.id) {
              audio = await songs.downloadAudio(found.id);
              mime = 'audio/ogg; codecs=opus';
            }
          }
          if (audio && audio.length > MAX_SONG) audio = null; // too big for WhatsApp
        } catch (e) {
          logger.warn(`reminder #${r.id} song failed:`, e.message || e);
          audio = null;
        }
        if (audio) {
          try {
            await sock.sendMessage(targetJid, { audio, mimetype: mime, ptt: true });
          } catch (e) {
            logger.warn(`reminder #${r.id} song send failed:`, e.message || e);
          }
        }
      }

      // 2) The text reminder.
      const text = r.recurring
        ? `⏰ *Reminder:* ${r.text}\n🔁 ${humanizeSchedule(r.schedule)}`
        : `⏰ *Reminder:* ${r.text}\n🕐 ${nairobiTime(r.due_at)}`;
      await sock.sendMessage(targetJid, { text });

      if (r.recurring) {
        store.updateReminderNext(r.id, nextOccurrence(r.schedule, Date.now()));
      } else {
        store.markReminderSent(r.id);
      }
      store.addCommandLog(targetJid, 'chat_command', `reminder fired: ${r.text}`);
      logger.info(`reminder #${r.id} fired → ${targetJid}`);
      fired++;
    } catch (e) {
      logger.warn(`reminder #${r.id} send failed:`, e.message);
    }
  }
  return fired;
}

// Background loop: fires due reminders as soon as they're due (even right
// after a restart — persisted reminders catch up).
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  setInterval(async () => {
    try {
      if (!session.getState().connected) return; // retry next tick
      const sock = session.getSocket();
      if (!sock) return;
      await fireDue(sock);
    } catch (e) {
      logger.warn('reminder loop error:', e.message);
    }
  }, 15000);
}

module.exports = { parseReminder, create, listText, removeByText, nairobiTime, humanizeSchedule, nextOccurrence, fireDue, startLoop };