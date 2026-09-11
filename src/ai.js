const { config } = require('./config');

async function chat(messages, { maxTokens = 250 } = {}) {
  const provider = config.aiProvider;

  if (provider === 'anthropic' && config.anthropicKey) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        system,
        messages: rest,
        max_tokens: maxTokens,
        temperature: 0.8,
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  if (provider === 'groq' && config.groqKey) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.groqModel,
        messages,
        temperature: 0.8,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  if (provider === 'gemini' && config.geminiKey) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${config.geminiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.geminiModel,
          messages,
          temperature: 0.8,
          max_tokens: maxTokens,
        }),
      }
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  if (config.openaiKey) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.openaiModel,
        messages,
        temperature: 0.8,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  throw new Error('No AI API key configured. Set AI_PROVIDER + GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY.');
}

async function chatJSON(system, text) {
  const out = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    { maxTokens: 200 }
  );
  const cleaned = out.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON returned: ' + out.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function transcribeAudio(buffer, mime = 'audio/ogg') {
  if (!config.whisperKey) throw new Error('Whisper key missing (set OPENAI_API_KEY or WHISPER_API_KEY)');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), 'voice.ogg');
  form.append('model', config.whisperModel);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whisperKey}` },
    body: form,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'whisper failed');
  return (data.text || '').trim();
}

module.exports = { chat, chatJSON, transcribeAudio };