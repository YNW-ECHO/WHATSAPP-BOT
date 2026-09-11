const { spawn, spawnSync } = require('child_process');
const { config } = require('./config');

// Text-to-speech + conversion to WhatsApp voice-note format (.ogg / Opus).
// Providers: 'openai' (default, simple/cheap) or 'elevenlabs' (best quality, voice clone).
// If the provider key is missing OR ffmpeg is not installed, synthesize() throws and the
// caller should fall back to a plain text reply (architecture §3.6 "graceful degradation").

function ffmpegAvailable() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

async function synthesize(text) {
  const provider = config.ttsProvider;

  if (provider === 'elevenlabs') {
    if (!config.elevenLabsKey) throw new Error('ELEVENLABS_API_KEY not set');
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenLabsKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: String(text).slice(0, 3000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // default: OpenAI TTS
  if (!config.openaiKey) throw new Error('OPENAI_API_KEY not set (TTS)');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tts-1',
      voice: config.ttsVoice,
      input: String(text).slice(0, 3000),
    }),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Convert any audio buffer (mp3/m4a/wav) to the .ogg Opus voice-note format.
// Returns buffer ready for WhatsApp ptt bubbles. Throws if ffmpeg is missing.
function toOgg(buffer, mime = 'audio/mpeg') {
  return new Promise((resolve, reject) => {
    const args = ['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'];
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (e) => reject(new Error('ffmpeg not available: ' + e.message)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg exited ' + code));
      resolve(Buffer.concat(out));
    });
    proc.stdin.end(buffer);
  });
}

module.exports = { synthesize, toOgg, ffmpegAvailable };