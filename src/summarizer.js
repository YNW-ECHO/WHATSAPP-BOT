const ai = require('./ai');
const store = require('./store');
const logger = require('./logger');
const { withTimeout } = require('./human');

// Rolling per-chat memory: every time the bot has a real conversation, it
// periodically condenses the recent history (plus the previous summary) into
// a short "memory" that is injected into the reply prompt. This lets the bot
// remember things beyond the last few messages / the stored history window.

const THRESHOLD = 12; // new history rows before we refresh the memory
const WINDOW = 30;    // how many recent messages the refresh looks at

const SYSTEM = `You maintain a rolling memory for a WhatsApp assistant about ONE conversation.
You are given the previous memory (if any) and the most recent messages.
Return ONLY a concise memory, 3 to 6 short bullet lines ("- ..."), covering durable context worth
remembering for future replies: who is involved, ongoing topics/plans/questions, preferences,
important details. Keep names exactly as the chat partner uses them.
Do NOT include greetings, goodbyes, filler or anything temporary. Plain text, no headings.`;

const busy = new Map();

async function maybeUpdate(jid) {
  if (!jid || jid === 'status@broadcast') return;
  if (busy.get(jid)) return;
  if (!ai.hasKey()) return;

  const prev = store.getSummary(jid);
  const maxId = store.maxHistoryId(jid);
  const newSince = store.countHistorySince(jid, prev ? prev.last_history_id : 0);

  // Not enough new context to bother, and nothing to seed yet.
  if (prev && newSince < THRESHOLD) return;
  if (!prev && maxId < THRESHOLD) return;

  busy.set(jid, true);
  try {
    const recent = store
      .getHistory(jid, WINDOW)
      .map((h) => `${h.role === 'user' ? '(in)' : '(out)'} ${h.text}`)
      .join('\n');
    const prompt = [
      prev ? `PREVIOUS MEMORY:\n${prev.summary}` : 'PREVIOUS MEMORY: (none yet)',
      `RECENT MESSAGES:\n${recent || '(none)'}`,
    ].join('\n\n');

    const summary = await withTimeout(
      ai.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 300 }),
      8000,
      null
    );
    if (summary && summary.trim()) {
      store.saveSummary(jid, summary.trim(), maxId);
      logger.info(`memory updated for ${jid}`);
    }
  } catch (e) {
    logger.warn('summary update failed:', e.message || e);
  } finally {
    busy.delete(jid);
  }
}

function summaryForPrompt(jid) {
  const s = store.getSummary(jid);
  return s ? s.summary : '';
}

function digitsOf(s) {
  return String(s || '').replace(/\D/g, '');
}

const IMPORT_MEMORY_SYSTEM = `You write a person profile from their WhatsApp conversations, so an assistant can instantly know them when they start chatting.
Return ONLY 3 to 6 short bullet lines ("- ..."): who they are, what matters to them, ongoing plans/topics, preferences, how they talk (language/slang/emoji use), anything durable worth remembering.
Keep names exactly as they use them. Plain text only, no headings.`;

// Import-time: build an evergreen memory for a person met only in a past chat
// export, so the moment they start chatting live the bot already knows them.
async function importMemory(otherLabel, transcript, ownerName) {
  const label = String(otherLabel || '').trim().slice(0, 60);
  if (!label || !ai.hasKey()) return false;
  const t = String(transcript || '').trim().slice(0, 6000);
  if (t.length < 20) return false;
  const ownerLine = ownerName ? `The other person is ${ownerName}.` : '';
  const summary = await withTimeout(
    ai.chat(
      [
        { role: 'system', content: IMPORT_MEMORY_SYSTEM },
        { role: 'user', content: `${ownerLine}\nPERSON: ${label}\n\nCONVERSATION:\n${t}` },
      ],
      { maxTokens: 300 }
    ),
    12000,
    null
  );
  if (!summary || !summary.trim()) return false;
  store.savePersonMemory(label, label, '', digitsOf(label), summary.trim());
  store.addCommandLog('', 'memory', `imported memory of chat with ${label}: ${summary.trim().slice(0, 160)}`);
  logger.info(`imported person memory for ${label}`);
  return true;
}

// Live-time: the bot just met someone in WhatsApp. If we have an imported
// memory for them, attach it to this chat's rolling summary immediately so it
// is used from the very first reply and kept forever (merged on later refreshes).
function attachMemoryFor(jid, contactName) {
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) return;
  const pm = store.getPersonMemoryByName(contactName || jid) || store.getPersonMemoryByName(jid);
  if (!pm || !pm.summary) return;
  if (pm.jid === jid) return;
  store.saveSummary(jid, pm.summary, store.maxHistoryId(jid));
  store.linkPersonMemory(pm.name, jid);
  store.addCommandLog(jid, 'memory', `started remembering ${pm.display || pm.name}: ${pm.summary.slice(0, 140)}`);
  logger.info(`attached imported memory → ${jid}`);
}

module.exports = { maybeUpdate, summaryForPrompt, importMemory, attachMemoryFor, THRESHOLD, WINDOW };