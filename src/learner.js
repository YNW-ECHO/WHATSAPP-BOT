const facts = require('./facts');
const summarizer = require('./summarizer');

// Import-time learning: a parsed WhatsApp chat feeds BOTH the durable knowledge
// base (facts) and an evergreen memory per person, so the bot knows them the
// moment they start chatting. Style samples are handled by the trainer directly.
async function learnConversation({ ownerName, otherLabels, msgs }) {
  const result = { facts: 0, memories: 0 };
  if (!Array.isArray(msgs) || !msgs.length) return result;
  const labels = Array.isArray(otherLabels) ? otherLabels.slice(0, 3) : [];

  for (const other of labels) {
    const lines = msgs
      .filter((m) => m.sender === other || m.isOwner)
      .map((m) => `${m.isOwner ? 'O' : 'X'}: ${m.text}`);
    const transcript = lines.slice(-120).join('\n');
    if (transcript.length < 20) continue;

    const learned = await facts.learnFromImport(transcript, '');
    result.facts += learned;

    const remembered = await summarizer.importMemory(other, transcript, ownerName);
    if (remembered) result.memories++;
  }

  // If the chat had no obvious "other" participant, still mine the whole thing.
  if (!labels.length) {
    const transcript = msgs.map((m) => `${m.isOwner ? 'O' : 'X'}: ${m.text}`).slice(-120).join('\n');
    result.facts += await facts.learnFromImport(transcript, '');
  }
  return result;
}

module.exports = { learnConversation };