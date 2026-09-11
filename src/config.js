require('dotenv').config();

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(v).toLowerCase());
}

const config = {
  name: process.env.BOT_NAME || 'Niaji',
  aiProvider: (process.env.AI_PROVIDER || 'openai').toLowerCase(),
openaiKey: process.env.OPENAI_API_KEY || '',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    geminiKey: process.env.GEMINI_API_KEY || '',
    groqKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  whisperKey: process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || '',
  whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
  googleKey: process.env.GOOGLE_API_KEY || '',
  googleCx: process.env.GOOGLE_CX || '',
  allowGroups: bool(process.env.ALLOW_GROUPS, false),
  autoReplyDefault: bool(process.env.AUTO_REPLY_DEFAULT, true),
  voiceAutoReply: bool(process.env.VOICE_AUTO_REPLY, false),
  ttsProvider: (process.env.TTS_PROVIDER || 'openai').toLowerCase(),
  ttsVoice: process.env.TTS_VOICE || 'alloy',
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  echoVoice: bool(process.env.ECHO_VOICE, false),
  minReplySpacing: Number(process.env.MIN_REPLY_SPACING_MS || 8000),
  maxReplyDelay: Number(process.env.MAX_REPLY_DELAY_MS || 7000),
  styleSampleCount: Number(process.env.STYLE_SAMPLE_COUNT || 30),
  dashPassword: process.env.DASH_PASSWORD || 'niaji-changeme',
  dashUser: process.env.DASH_USER || 'admin',
  dashboardHost: process.env.DASH_HOST || '0.0.0.0',
  ownerJid: process.env.OWNER_JID || '',
  keepAliveUrl: process.env.KEEPALIVE_URL || '',
  keepAliveToken: process.env.KEEPALIVE_TOKEN || '',
  port: Number(process.env.PORT || 3000),
};

module.exports = { config, bool };