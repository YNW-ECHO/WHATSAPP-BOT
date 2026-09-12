const ai = require('./ai');
const store = require('./store');
const logger = require('./logger');
const { withTimeout } = require('./human');

// Turns the owner's own outgoing messages into durable "facts" the bot can
// remember and reuse across every reply (a lightweight knowledge base).
//
// Runs fire-and-forget from the message router: throttled, never blocks the
// reply path, and safely no-ops when no AI key is configured.

const SYSTEM = `You extract durable, useful facts or preferences a person says about people or things in their WhatsApp messages.
Return ONLY JSON in this exact shape: {"facts":[{"subject":"...","fact":"..."}]}
Rules:
- subject: a short label for who/what the fact is about (e.g. "Mama", "Boss", "the car"). Keep it exactly as the person wrote it.
- fact: one short clause, present tense, no quotes or newlines (e.g. "likes chai strong").
- Include only real, durable info worth remembering: preferences, relationships, habits, plans, details, important context.
- Skip greetings, questions, jokes, commands, filler, or anything trivial or temporary.
- Maximum 3 facts. If nothing useful, return {"facts":[]}`;

let running = false;
let nextAllowedAt = 0;

async function extractAndStore(text, sourceJid) {
  try {
    if (running || Date.now() < nextAllowedAt) return;
    if (!ai.hasKey()) return;
    const t = String(text || '').trim();
    if (t.length < 4 || t.length > 1000) return;

    running = true;
    nextAllowedAt = Date.now() + 4000;
    try {
      const parsed = await withTimeout(ai.chatJSON(SYSTEM, t), 6000, null);
      if (!parsed) return;
      const list = Array.isArray(parsed.facts) ? parsed.facts : [];
      let learned = 0;
      for (const f of list) {
        const subject = String(f.subject || '').trim().slice(0, 60);
        const fact = String(f.fact || '').trim().slice(0, 240);
        if (!subject || fact.length < 3) continue;
        const r = store.addFact(sourceJid || '', subject, fact);
        if (!r) continue;
        store.addCommandLog(sourceJid || '', 'fact', `${subject}: ${fact}`);
        if (r.created) learned++;
      }
      if (learned) logger.info(`learned ${learned} fact(s) from: "${t.slice(0, 60)}"`);
    } finally {
      running = false;
    }
  } catch (e) {
    // Extractions are best-effort; never let them disturb the bot flow.
    running = false;
  }
}

const IMPORT_SYSTEM = `You read a WhatsApp conversation. Lines prefixed "O:" are messages the OWNER wrote; "X:" are from the other person.
Extract durable facts worth remembering about anyone or anything mentioned: preferences, relationships, habits, plans, important details about people ("Felix Roadi came back from Eldoret", "Mama wants a new sofa").
Return ONLY JSON in this exact shape: {"facts":[{"subject":"...","fact":"..."}]}
Rules:
- subject: a short label for who/what the fact is about (name exactly as written, else "the car", "work", etc.).
- fact: one short present-tense clause, no quotes or newlines.
- Skip greetings, jokes, questions, filler, or anything trivial or temporary.
- Maximum 8 facts. If nothing useful, return {"facts":[]}`;

// Batch learning used at import time: reads a whole past chat and stores the
// durable knowledge it contains. Returns how many NEW facts were learned.
async function learnFromImport(transcript, sourceJid) {
  try {
    const t = String(transcript || '').trim().slice(0, 8000);
    if (t.length < 20 || !ai.hasKey()) return 0;
    const parsed = await withTimeout(ai.chatJSON(IMPORT_SYSTEM, t), 15000, null);
    if (!parsed) return 0;
    const list = Array.isArray(parsed.facts) ? parsed.facts : [];
    let learned = 0;
    for (const f of list) {
      const subject = String(f.subject || '').trim().slice(0, 60);
      const fact = String(f.fact || '').trim().slice(0, 240);
      if (!subject || fact.length < 3) continue;
      const r = store.addFact(sourceJid || '', subject, fact);
      if (!r) continue;
      store.addCommandLog(sourceJid || '', 'fact', `${subject}: ${fact}`);
      if (r.created) learned++;
    }
    if (learned) logger.info(`import learned ${learned} fact(s)`);
    return learned;
  } catch (e) {
    logger.warn('import fact learning failed:', e.message || e);
    return 0;
  }
}

module.exports = { extractAndStore, learnFromImport, SYSTEM };