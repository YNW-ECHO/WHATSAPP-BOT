const { config } = require('./config');
const ai = require('./ai');
const { searchWeb } = require('./search');
const store = require('./store');
const { withTimeout } = require('./human');

const SYSTEM_TEMPLATE = (name, style, factsBlock, memoryBlock) =>
  `You are ${name}, a friendly Kenyan person chatting on WhatsApp. A friend just messaged you.

Rules:
- Reply in the SAME language/vibe the friend used: English, Swahili, or Kenyan Sheng (mixed). Match them.
- Be CONCISE: 1 to 3 short sentences. Casual and natural, like a real text — no lists, no headings.
- Sound human: use natural Kenyan texting style, but don't force slang.
- If the friend asks something factual or current (meaning of slang/words, prices, news, trends, events, who/what), answer from "WEB INFO" below when provided. If not sure, say so briefly and honestly.
- If asked who you are, say you are ${name}.
- NEVER mention that you are a bot, an AI, OpenAI, Anthropic, or that you used a web search.
- NEVER say, write or repeat the word "choo" (or "choo choo"), ever — not in any reply, not even playfully. Replace it with natural alternatives or leave it out entirely.
- Understand Kenyan Sheng: "sasa mkuu", "niko niaje", "umeamka aje", "kazi kwa bidii", "vibes", "noma", "mbao", "ganji", "story ziko", "mshiko", "nigga wapi" etc. Respond naturally in kind.
- Messages longer than a few short lines are NOT allowed.
${
  style
    ? `\nSTRONG STYLE GUIDE — these are REAL messages ${name} sent; imitate their exact voice, tone, sentence length, punctuation, slang, and language-mixing:\n${style}\nUse emojis the same way and as often as the samples do when it feels natural; otherwise keep them light.`
    : ''
}
${
  factsBlock
    ? `\nKNOWN FACTS about people/things ${name} mentioned before — use them only when relevant to answer correctly, never contradict them:\n${factsBlock}`
    : ''
}
${
  memoryBlock
    ? `\nEARLIER CONVERSATION MEMORY (context from before the latest messages — use it to stay consistent):\n${memoryBlock}`
    : ''
}

Return ONLY your reply text.`;

function looksInformational(text) {
  const t = text.trim().toLowerCase();
  if (t.includes('?')) return true;
  if (/^(who|what|when|where|why|how|is|are|does|did|do|can|which|whats|what's|nini|wapi|lini|gani|aje)/.test(t)) return true;
  const kw = [
    'meaning', 'means', 'price', 'trending', 'news', 'latest', 'today', 'who is',
    'what is', 'sheng', 'slang', 'translate', 'definition', 'cost', 'amount',
  ];
  return kw.some((k) => t.includes(k));
}

function normalizeMessages(history, incomingText) {
  const msgs = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h.text || '');
    if (!content) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += '\n' + content;
    else msgs.push({ role, content });
  }
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant') msgs.push({ role: 'user', content: incomingText });
  else if (last) last.content += '\n' + incomingText;
  else msgs.push({ role: 'user', content: incomingText });
  return msgs;
}

function cleanReply(r) {
  return String(r || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')
    .replace(/^["\u2018\u201c]+|["\u2019\u201d]+$/g, '')
    .trim();
}

async function createReply(sock, jid, incomingText) {
  const noKey =
    (config.aiProvider === 'groq' && !config.groqKey) ||
    (config.aiProvider === 'gemini' && !config.geminiKey) ||
    (config.aiProvider === 'anthropic' && !config.anthropicKey) ||
    (config.aiProvider !== 'groq' && config.aiProvider !== 'gemini' && config.aiProvider !== 'anthropic' && !config.openaiKey);
  if (noKey) return null;

  const history = store.getHistory(jid, 8);
  const styleSamples = store.getStyleSamples(config.styleSampleCount || 30);
  const factsBlock = store.factsForPrompt(8);
  const memoryBlock = store.getSummary(jid)?.summary || '';
  let webNote = '';
  if (looksInformational(incomingText)) {
    const results = await withTimeout(searchWeb(incomingText), 5000, []);
    if (results && results.length) {
      webNote =
        'WEB INFO (used only if relevant to answer correctly — never mention it):\n' +
        results
          .map((r) => `- ${r.title}. ${r.snippet}`.slice(0, 400))
          .join('\n');
    }
  }

  const styleBlock = styleSamples
    .map((s) => `- ${s.text}`.slice(0, 240))
    .join('\n');

  // Dashboard "System prompt override": when set, it fully replaces the built-in
  // template (the owner's own instructions), otherwise the default template runs.
  const override = store.getSetting('system_prompt', '').trim();
  const baseSystem = override || SYSTEM_TEMPLATE(config.name, styleBlock, factsBlock, memoryBlock);

  const messages = [
    {
      role: 'system',
      content: baseSystem + (webNote ? '\n\n' + webNote : ''),
    },
    ...normalizeMessages(history, incomingText),
  ];

  const reply = await ai.chat(messages, { maxTokens: 200 });
  return cleanReply(reply);
}

module.exports = { createReply };