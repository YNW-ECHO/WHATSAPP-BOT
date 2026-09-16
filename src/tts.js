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

// Voice names the admin dashboard offers for sponsor ads.
function listVoices() {
  return {
    openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    elevenlabs: config.elevenLabsKey ? [config.elevenLabsVoiceId] : [],
  };
}

async function synthesize(text, voice) {
  const provider = config.ttsProvider;

  if (provider === 'elevenlabs') {
    if (!config.elevenLabsKey) throw new Error('ELEVENLABS_API_KEY not set');
    const vId = voice && /^[A-Za-z0-9]{11,32}$/.test(voice) ? voice : config.elevenLabsVoiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${vId}`;
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
      signal: AbortSignal.timeout(20000),
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
      voice: voice || config.ttsVoice,
      input: String(text).slice(0, 3000),
    }),
    signal: AbortSignal.timeout(20000),
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
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        if (proc.exitCode === null) proc.kill();
      } catch (e2) {}
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('ffmpeg timed out')), 30000);
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (e) => {
      clearTimeout(timer);
      fail(new Error('ffmpeg not available: ' + e.message));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        const tail = Buffer.concat(err).toString().slice(-200);
        return reject(new Error(`ffmpeg exited ${code}${tail ? ': ' + tail : ''}`));
      }
      settled = true;
      resolve(Buffer.concat(out));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(buffer);
  });
}

module.exports = { synthesize, toOgg, ffmpegAvailable, listVoices };