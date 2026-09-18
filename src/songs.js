const { spawn, spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const { generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const logger = require('./logger');
const store = require('./store');
const session = require('./session');
const { config } = require('./config');
const tts = require('./tts');
const { withTimeout } = require('./human');

// "play <song>" feature: detect a song request, search YouTube, and offer a
// tappable WhatsApp menu (mp3 / voice note / mp4). Tapping an option downloads
// and sends it as a media message that plays right in the chat. Download/encode
// failures fall back through several formats so the song still lands instead of
// a dead "can't do it" reply.

const MAX_MEDIA = 15 * 1024 * 1024;      // keep under WhatsApp's media ceiling
const PENDING_TTL = 5 * 60 * 1000;       // song choice expires after 5 min
const AUDIO_TIMEOUT = 90000;
const VIDEO_TIMEOUT = 180000;

// A real browser UA reduces YouTube throttling/blocking from datacenter IPs.
const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

let _ffmpeg = null;
function hasFFmpeg() {
  if (_ffmpeg === null) {
    try {
      const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      _ffmpeg = r.status === 0;
    } catch (e) {
      _ffmpeg = false;
    }
  }
  return _ffmpeg;
}

let _ytDlp = null;
function ytDlpAvailable() {
  if (_ytDlp === null) {
    try {
      const r = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' });
      _ytDlp = r.status === 0;
    } catch (e) {
      _ytDlp = false;
    }
  }
  return _ytDlp;
}

const pending = new Map();               // jid -> { id, title, author, at }

const SONG_RE =
  /^\s*(?:play|play\s+me|put\s+on|can\s+(?:you|u|ya)\s+play|please\s+play|stream|drop)\s+(.+)$/i;

function extractQuery(text) {
  const t = String(text || '').trim();
  const m = t.match(SONG_RE);
  const q = (m ? m[1] : '').trim();
  // "play" without a real subject ("play it") is almost certainly not a song
  // request — leave it to the normal conversational reply.
  if (q.replace(/[^a-z0-9]/gi, '').length < 4) return '';
  return q;
}

async function sendNote(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {}
}

async function record(sock, jid, label) {
  store.setLastSent(jid, Date.now());
  store.addHistory(jid, 'assistant', label);
  store.addCommandLog(jid, 'send', label);
  logger.info(`song sent → ${jid}: ${label}`);
}

function streamToBuffer(input, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch (e) {}
      try {
        if (input.destroy) input.destroy();
      } catch (e) {}
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('conversion timed out')), timeoutMs);
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (e) => fail(new Error('ffmpeg not available: ' + e.message)));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        const tail = Buffer.concat(err).toString().slice(-300);
        return reject(new Error('ffmpeg exit ' + code + (tail ? ': ' + tail : '')));
      }
      settled = true;
      resolve(Buffer.concat(out));
    });
    proc.stdin.on('error', () => {});
    input.on('error', (e) => fail(new Error('download error: ' + (e.message || e))));
    input.pipe(proc.stdin);
  });
}

async function downloadAudio(id) {
  const stream = ytdl('https://www.youtube.com/watch?v=' + id, {
    filter: 'audioonly',
    quality: 'lowestaudio',
    requestOptions: { headers: UA },
  });
  return streamToBuffer(
    stream,
    ['-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1'],
    AUDIO_TIMEOUT
  );
}

async function downloadVideo(id) {
  const stream = ytdl('https://www.youtube.com/watch?v=' + id, {
    filter: 'audioandvideo',
    quality: 'lowest',
    requestOptions: { headers: UA },
  });
  // Re-encode to H.264/AAC mp4: YouTube's lowest streams are often webm
  // (VP9/Opus), which cannot be copied into an .mp4 container and would be
  // rejected by WhatsApp. Re-encoding guarantees a playable video.
  return streamToBuffer(
    stream,
    [
      '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4', 'pipe:1',
    ],
    VIDEO_TIMEOUT
  );
}

// Collect a ytdl stream buffer WITHOUT ffmpeg (10MB / max 25MB chunks) — used
// as a last-resort path when ffmpeg re-encoding is unavailable or fails.
function streamToBufferRaw(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('download timed out'));
      }
    }, timeoutMs);
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

// getInfo with a few different player-client combos so a change on YouTube's
// side in one client doesn't kill every download. Returns full info (with
// deciphered formats) or throws the last error.
async function getInfoRobust(id) {
  const url = 'https://www.youtube.com/watch?v=' + id;
  const attempts = [
    {}, // library defaults: WEB_EMBEDDED + IOS + ANDROID + TV
    { playerClients: ['WEB', 'TV'] },
    { playerClients: ['WEB_EMBEDDED', 'IOS', 'ANDROID'] },
    { playerClients: ['ANDROID'] },
    { playerClients: ['IOS'] },
  ];
  let lastErr = new Error('no format info');
  for (const extra of attempts) {
    try {
      const info = await ytdl.getInfo(url, { requestOptions: { headers: UA }, ...extra });
      if (info && Array.isArray(info.formats) && info.formats.length) return info;
      lastErr = new Error('info returned no formats');
    } catch (e) {
      lastErr = e;
      logger.warn('ytdl getInfo attempt failed:', (e.message || e).slice(0, 120));
    }
  }
  throw lastErr;
}

// Best playable audio WITHOUT ffmpeg: a native m4a/aac stream (itag 139/140/141)
// sent straight to WhatsApp as an audio file. Returns { buffer, mimetype } or null.
async function downloadAudioNative(id) {
  const url = 'https://www.youtube.com/watch?v=' + id;
  try {
    const info = await getInfoRobust(id);
    const candidates = (info.formats || []).filter((f) => f.hasAudio && !f.hasVideo);
    const m4a = candidates.filter((f) => /mp4|m4a|aac/i.test(String(f.mimeType || '')));
    const pick =
      m4a.find((f) => f.itag === 140) ||
      m4a.find((f) => f.itag === 141) ||
      m4a.find((f) => f.itag === 139) ||
      m4a[0] ||
      candidates[0];
    if (!pick || !pick.itag) return null;
    const mime = String(pick.mimeType || 'audio/mp4').split(';')[0].trim() || 'audio/mp4';
    const stream = ytdl(url, { quality: pick.itag, requestOptions: { headers: UA } });
    const buf = await withTimeout(streamToBufferRaw(stream, AUDIO_TIMEOUT), AUDIO_TIMEOUT, null);
    if (!buf || buf.length === 0) return null;
    return { buffer: buf, mimetype: mime };
  } catch (e) {
    logger.warn('native audio download failed:', (e.message || e).slice(0, 120));
    return null;
  }
}

// Native H.264/AAC mp4 (itag 18) downloaded as-is — needs no encoding, so it
// still lands when ffmpeg is missing. Returns null on any failure.
async function downloadRawMp4(id) {
  const url = 'https://www.youtube.com/watch?v=' + id;
  try {
    const info = await getInfoRobust(id);
    const fmt = (info?.formats || []).find(
      (f) => f.hasVideo && f.hasAudio && /^video\/mp4/.test(String(f.mimeType || ''))
    );
    if (!fmt) return null;
    const stream = ytdl(url, { quality: fmt.itag, requestOptions: { headers: UA } });
    return await withTimeout(streamToBufferRaw(stream, VIDEO_TIMEOUT), VIDEO_TIMEOUT, null);
  } catch (e) {
    logger.warn('native mp4 download failed:', (e.message || e).slice(0, 120));
    return null;
  }
}

// Absolute-last fallback when ytdl-core can't extract at all: shell out to the
// yt-dlp binary if it is installed (far more resilient to YouTube changes).
// kind: 'm4a' → best audio-only m4a; 'mp4' → itag 18 build. Returns Buffer or null.
function downloadViaYtDlp(id, kind = 'm4a') {
  if (!ytDlpAvailable()) return Promise.resolve(null);
  const url = 'https://www.youtube.com/watch?v=' + id;
  const args =
    kind === 'mp4'
      ? ['--no-playlist', '-f', '18/best[ext=mp4]/best', '-o', '-', url]
      : ['--no-playlist', '-f', 'bestaudio[ext=m4a]/bestaudio', '-o', '-', url];
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill();
        } catch (e) {}
        resolve(null);
      }
    }, kind === 'mp4' ? VIDEO_TIMEOUT : AUDIO_TIMEOUT);
    proc.stdout.on('data', (c) => {
      if (!settled) chunks.push(c);
    });
    proc.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });
  });
}

// Convert the lowest audio track to a real .mp3 so WhatsApp shows a playable
// audio file with a progress bar (what people mean by "play an mp3").
async function downloadMp3(id) {
  const stream = ytdl('https://www.youtube.com/watch?v=' + id, {
    filter: 'audioonly',
    quality: 'lowestaudio',
    requestOptions: { headers: UA },
  });
  return streamToBuffer(
    stream,
    ['-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'],
    AUDIO_TIMEOUT
  );
}

// Run a download/encode with a hard timeout; resolve null instead of throwing
// so each format can fall through to the next one cleanly.
async function safe(promise, ms) {
  try {
    return await withTimeout(promise, ms, null);
  } catch (e) {
    return null;
  }
}

// Send a TAPPABLE format menu (WhatsApp List Message): mp3 / voice note / mp4.
// The tap comes back to the bot as a listResponseMessage, which the router
// forwards to handleChoice(). Falls back to a plain-text prompt if the
// interactive message is rejected.
async function sendFormatMenu(sock, jid, title, author) {
  const heading = `🎵 *${title}*${author ? ' by _' + author + '_' : ''}`;
  try {
    const msg = generateWAMessageFromContent(
      jid,
      {
        listMessage: {
          title: heading,
          description: 'How do you want to hear it?',
          buttonText: 'Choose format',
          footerText: 'Tap "Choose format" below 👇',
          listType: 1,
          sections: [
            {
              title: 'Play as',
              rows: [
                { rowId: 'mp3', title: '🎵 mp3', description: 'Playable audio file with a progress bar' },
                { rowId: 'voice', title: '🎤 Voice note', description: 'Listen to it as a WhatsApp voice note' },
                { rowId: 'mp4', title: '🎬 mp4 video', description: 'Watch the music video' },
              ],
            },
          ],
        },
      },
      { userJid: sock.user?.id }
    );
    const id = msg.key.id;
    await sock.relayMessage(jid, msg.message, { messageId: id });
    session.markSent(id);
    store.addHistory(jid, 'assistant', `🎵 ${title}${author ? ' by ' + author : ''} — format menu shown`);
    return;
  } catch (e) {
    logger.warn('format menu failed, using text prompt:', e.message);
  }
  await sendNote(
    sock,
    jid,
    `${heading}.\nReply *mp3* to play it, *voice* for a voice note, or *mp4* for the video.`
  );
}

// Search YouTube for a song query ("legend by bob marley"), prefer a normal,
// downloadable upload. Returns { id, title, author } or null.
async function searchSong(query) {
  const results = await withTimeout(ytSearch(String(query || '')), 12000, null);
  if (!results || !Array.isArray(results.videos) || !results.videos.length) return null;
  const videos = Array.isArray(results.videos) ? results.videos : [];
  const video =
    videos.find((v) => !v.isLive && v.seconds > 0 && v.seconds <= 900) ||
    videos.find((v) => !v.isLive) ||
    videos[0];
  if (!video || !video.videoId) return null;
  return {
    id: video.videoId,
    title: video.title,
    author: (video.author && video.author.name) || '',
  };
}

// Convert an arbitrary audio Buffer (mp3/wav/aac/…) into a WhatsApp-ready
// Opus/OGG voice note. Fails loudly if ffmpeg is missing.
async function bufferToOpusOgg(buffer, timeoutMs) {
  const input = new PassThrough();
  input.end(buffer);
  return streamToBuffer(
    input,
    ['-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1'],
    timeoutMs || 60000
  );
}

// Sponsor slot: plays the configured ad (AI-voiced from SPONSOR_TEXT, or your
// own SPONSOR_AUDIO_URL clip) plus a text shout-out. No-ops when no sponsor is
// configured (the normal user experience is untouched).
async function playSponsor(sock, jid) {
  // Live settings from the admin dashboard override the .env defaults, so the
  // ad can be edited (on/off, name, text, audio) without redeploying.
  const s0 = config.sponsor;
  const gv = (k, d) => {
    const v = store.getSetting('sponsor_' + k, '');
    return v === '' ? d : v;
  };
  const gvb = (k, d) => {
    const v = store.getSetting('sponsor_' + k, '');
    return v === '' ? d : v === '1';
  };
  const s = {
    enabled: gvb('enabled', s0.enabled),
    name: String(gv('name', s0.name) || '').trim(),
    text: String(gv('text', s0.text) || '').trim(),
    audioUrl: String(gv('audio_url', s0.audioUrl) || '').trim(),
    voice: String(gv('voice', s0.voice) || 'alloy').trim(),
    tts: gvb('tts', s0.tts),
    uploadPath: String(store.getSetting('sponsor_upload_path', '') || '').trim(),
    uploadMime: String(store.getSetting('sponsor_upload_mime', '') || 'audio/mpeg').trim(),
  };

  if (!s.enabled) return;

  const script =
    s.text ||
    `Hi! This is ${s.name || 'an ad slot'} on Chris's bot. Want your advert here? Every song request plays our audio and text — ask the owner about a slot!`;

  // Voice note, in priority order: your uploaded recording → your audio URL →
  // AI TTS reading the ad text aloud in your chosen voice.
  try {
    let audio = null;
    let mime = 'audio/ogg; codecs=opus';
    if (s.uploadPath && fs.existsSync(s.uploadPath)) {
      const buf = fs.readFileSync(s.uploadPath);
      if (buf.length) {
        try {
          audio = await bufferToOpusOgg(buf);
        } catch (e) {
          audio = buf;
          mime = s.uploadMime;
        }
      }
    }
    if (!audio && s.audioUrl) {
      const res = await fetch(s.audioUrl, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      if (res.ok) {
        let buf = Buffer.from(await res.arrayBuffer());
        try {
          audio = await bufferToOpusOgg(buf);
        } catch (e) {
          audio = buf;
          const ext = (String(s.audioUrl).split('?')[0].match(/\.(\w+)$/) || [])[1] || 'mp3';
          mime = ext === 'ogg' || ext === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        }
      }
    }
    if (!audio && s.tts) {
      try {
        audio = await tts.synthesize(script, s.voice);
        try {
          audio = await tts.toOgg(audio);
        } catch (e) {
          mime = 'audio/mpeg'; // ffmpeg missing → send the raw TTS mp3
        }
      } catch (e) {
        logger.warn('sponsor AI voice failed:', e.message || e);
        audio = null;
      }
    }
    if (audio && audio.length) {
      await sock.sendMessage(jid, {
        audio,
        mimetype: mime,
        ...(mime === 'audio/ogg; codecs=opus' ? { ptt: true } : {}),
      });
    }
  } catch (e) {
    logger.warn('sponsor voice note failed:', e.message || e);
  }

  // 2) The text shout-out always follows, so the ad still lands even if the
  //    voice note can't be made (no TTS key, no ffmpeg, offline).
  const lines = [`📢 *Sponsored by ${s.name || 'this bot'}*`];
  lines.push(
    s.text ||
      'Want to advertise here? Every song request plays your audio + text. Ask the owner how to get a slot!'
  );
  await sock.sendMessage(jid, { text: lines.join('\n') });
  // One impression per delivered ad — used for the sponsor reach report.
  store.addAdImpression(jid);
}

// deliver the song in the requested format. Every format falls back through a
// chain of playable sources so the song lands even when ffmpeg is missing or
// YouTube throttles one download path:
//   mp3   → ffmpeg mp3 → native m4a audio → native mp4 (video) → yt-dlp → apology
//   voice → ffmpeg opus ptt → native m4a audio → native mp4 (video) → apology
//   mp4   → ffmpeg H.264 → native itag-18 mp4 → yt-dlp mp4 → apology
async function deliver(sock, jid, pend, want) {
  const title = pend.title || 'this song';
  const by = pend.author ? ' by _' + pend.author + '_' : '';
  const hasFf = hasFFmpeg();
  logger.info(`song delivery start — ${want} | ${pend.id} | ffmpeg=${hasFf} ytdlp=${ytDlpAvailable()}`);

  // The sponsor ad goes FIRST (radio-style), then the actual song.
  await playSponsor(sock, jid);
  await sendNote(sock, jid, `🎵 *${title}*${by} — grabbing it, one sec…`);

  const okAudio = (buf) => !!buf && buf.length > 0 && buf.length <= MAX_MEDIA;
  const tryNativeAudio = async () => {
    const n = await safe(downloadAudioNative(pend.id), AUDIO_TIMEOUT + 10000);
    return n && okAudio(n.buffer) ? n : null;
  };
  const tryNativeVideo = async () => {
    const v = await safe(downloadRawMp4(pend.id), VIDEO_TIMEOUT + 10000);
    return okAudio(v) ? v : null;
  };
  const sendAudio = async (buf, mime) => {
    await sock.sendMessage(jid, { audio: buf, mimetype: mime });
  };

  try {
    if (want === 'mp4') {
      // 1) ffmpeg H.264/AAC re-encode (if ffmpeg is present)
      if (hasFf) {
        const mp4 = await safe(downloadVideo(pend.id), VIDEO_TIMEOUT + 10000);
        if (okAudio(mp4)) {
          await sock.sendMessage(jid, { video: mp4, mimetype: 'video/mp4', caption: `🎵 ${title}\nEnjoy! 🎶` });
          record(sock, jid, `🎵 ${title} (video)`);
          return sendNote(sock, jid, 'Done! 🎬 Reply *mp3* for the audio, or *voice* for a voice note.');
        }
      }
      // 2) native itag-18 mp4 (works without ffmpeg)
      const mp4v = await tryNativeVideo();
      if (mp4v) {
        await sock.sendMessage(jid, { video: mp4v, mimetype: 'video/mp4', caption: `🎵 ${title}\nEnjoy! 🎶` });
        record(sock, jid, `🎵 ${title} (video)`);
        return sendNote(sock, jid, 'Done! 🎬 Reply *mp3* for the audio, or *voice* for a voice note.');
      }
      // 3) yt-dlp mp4
      const mp4y = await safe(downloadViaYtDlp(pend.id, 'mp4'), VIDEO_TIMEOUT + 10000);
      if (okAudio(mp4y)) {
        await sock.sendMessage(jid, { video: mp4y, mimetype: 'video/mp4', caption: `🎵 ${title}\nEnjoy! 🎶` });
        record(sock, jid, `🎵 ${title} (video)`);
        return sendNote(sock, jid, 'Done! 🎬 Reply *mp3* for the audio, or *voice* for a voice note.');
      }
      return sendNote(sock, jid, 'That video is too big or can\'t be grabbed right now — try the *mp3* or *voice note* version instead.');
    }

    if (want === 'voice') {
      // 1) Opus voice note (needs ffmpeg)
      if (hasFf) {
        const ogg = await safe(downloadAudio(pend.id), AUDIO_TIMEOUT + 10000);
        if (okAudio(ogg)) {
          await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
          record(sock, jid, `🎵 ${title} (voice note)`);
          return sendNote(sock, jid, '🎤 Done! Reply *mp4* for the video.');
        }
      }
      // 2) native m4a audio file (plays even without ffmpeg)
      const nat = await tryNativeAudio();
      if (nat) {
        await sendAudio(nat.buffer, nat.mimetype || 'audio/mp4');
        record(sock, jid, `🎵 ${title} (audio)`);
        return sendNote(sock, jid, '🎵 Here\'s the audio (voice notes need ffmpeg, so this plays as a file). Reply *mp4* for the video.');
      }
      // 3) everything else failed → the mp4 still proves it plays
      const vNat = await tryNativeVideo();
      if (vNat) {
        await sock.sendMessage(jid, { video: vNat, mimetype: 'video/mp4', caption: `🎵 ${title}\nEnjoy! 🎶` });
        record(sock, jid, `🎵 ${title} (video)`);
        return sendNote(sock, jid, '🎵 Couldn\'t pull the audio separate, so here\'s the full video instead.');
      }
      return sendNote(sock, jid, 'Couldn\'t grab the audio right now (or it\'s too big). Try a different song.');
    }

    // want === 'mp3' (the default pick in the menu): real playable audio file.
    // 1) mp3 encode (needs ffmpeg)
    if (hasFf) {
      const mp3 = await safe(downloadMp3(pend.id), AUDIO_TIMEOUT + 10000);
      if (okAudio(mp3)) {
        await sock.sendMessage(jid, { audio: mp3, mimetype: 'audio/mpeg' });
        record(sock, jid, `🎵 ${title} (mp3)`);
        await sendNote(sock, jid, '🎵 Done! Reply *mp4* for the video, or *voice* for a voice note.');
        return;
      }
    }
    // 2) native m4a audio (no ffmpeg needed — plays right in WhatsApp)
    const nat = await tryNativeAudio();
    if (nat) {
      await sendAudio(nat.buffer, nat.mimetype || 'audio/mp4');
      record(sock, jid, `🎵 ${title} (audio)`);
      return sendNote(sock, jid, '🎵 Done! Reply *mp4* for the video, or *voice* for a voice note.');
    }
    // 3) Opus voice note via ffmpeg (last ffmpeg chance)
    if (hasFf) {
      const ogg = await safe(downloadAudio(pend.id), AUDIO_TIMEOUT + 10000);
      if (okAudio(ogg)) {
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        record(sock, jid, `🎵 ${title} (voice note)`);
        return sendNote(sock, jid, '🎵 Done! Reply *mp4* for the video.');
      }
    }
    // 4) the mp4 always proves it plays as a video
    const vNat = await tryNativeVideo();
    if (vNat) {
      await sock.sendMessage(jid, { video: vNat, mimetype: 'video/mp4', caption: `🎵 ${title}\nEnjoy! 🎶` });
      record(sock, jid, `🎵 ${title} (video)`);
      return sendNote(sock, jid, '🎵 Audio stream isn\'t available, so I sent the full video instead.');
    }
    // 5) absolute last resort: yt-dlp
    const m4aY = await safe(downloadViaYtDlp(pend.id, 'm4a'), AUDIO_TIMEOUT + 10000);
    if (okAudio(m4aY)) {
      await sendAudio(m4aY, 'audio/mp4');
      record(sock, jid, `🎵 ${title} (audio)`);
      return sendNote(sock, jid, '🎵 Done! Reply *mp4* for the video.');
    }
    return sendNote(sock, jid, 'Couldn\'t grab the audio right now (or it\'s too big). Try a different song.');
  } catch (e) {
    logger.warn('song delivery failed:', e.message || e);
    await sendNote(sock, jid, 'Sorry, the download failed — try again or pick another song.');
  }
}

// Consume a format tap from the WhatsApp List Message menu (rowIds: mp3,
// voice, mp4). Returns true when a pending song was delivered.
async function handleChoice(sock, jid, choice) {
  const pend = pending.get(jid);
  if (!pend || Date.now() - pend.at > PENDING_TTL) return false;
  const want =
    choice === 'mp3' || choice === 'audio' ? 'mp3'
    : choice === 'voice' || choice === 'voicenote' || choice === 'ptt' ? 'voice'
    : choice === 'mp4' || choice === 'video' ? 'mp4'
    : '';
  if (!want) return false;
  pending.delete(jid);
  await deliver(sock, jid, pend, want);
  return true;
}

// Returns true when the message was part of the song flow (so the router does
// NOT also produce a normal AI reply), false when it isn't a song request.
async function handle(sock, jid, text) {
  const t = String(text || '').trim();
  if (!t || jid === 'status@broadcast') return false;

  // 1) A plain-text reply picking a format for the song we offered: "mp3",
  //    "voice", "mp4", "video", "audio" (the taps come through handleChoice).
  const pend = pending.get(jid);
  if (pend && Date.now() - pend.at < PENDING_TTL) {
    const lower = t.toLowerCase().trim();
    const want =
      lower === 'mp3' || lower === 'audio' ? 'mp3'
      : lower === 'voice' || lower === 'voicenote' || lower === 'ptt' ? 'voice'
      : lower === 'mp4' || lower === 'video' ? 'mp4'
      : '';
    if (want) {
      pending.delete(jid);
      await deliver(sock, jid, pend, want);
      return true;
    }
    // Something else while a choice is pending: drop the stale choice unless
    // this new message is itself a song request.
    if (!extractQuery(t)) pending.delete(jid);
  }

  // 2) New song request.
  const q = extractQuery(t);
  if (!q) return false;
  // Expire stale choices from other chats so the map never leaks.
  const nowMs = Date.now();
  for (const [k, v] of pending) {
    if (nowMs - v.at > PENDING_TTL) pending.delete(k);
  }
  store.addHistory(jid, 'user', t);
  const results = await withTimeout(ytSearch(q), 12000, null);
  if (!results || !Array.isArray(results.videos) || !results.videos.length) {
    await sendNote(
      sock,
      jid,
      'Couldn\'t find a song matching that. Try again with the title and artist, e.g. "play rapstar by polo g".'
    );
    return true;
  }
  // Prefer a normal, downloadable upload: skip live streams and anything
  // extreme long/short so the media fits WhatsApp comfortably. Fall back to
  // the first search hit if nothing matches.
  const videos = Array.isArray(results.videos) ? results.videos : [];
  const video =
    videos.find((v) => !v.isLive && v.seconds > 0 && v.seconds <= 900) ||
    videos.find((v) => !v.isLive) ||
    videos[0];
  if (!video || !video.videoId) {
    await sendNote(
      sock,
      jid,
      'Couldn\'t find a playable song for that. Try again with the title and artist, e.g. "play rapstar by polo g".'
    );
    return true;
  }
  pending.set(jid, {
    id: video.videoId,
    title: video.title,
    author: (video.author && video.author.name) || '',
    at: Date.now(),
  });
  await sendFormatMenu(sock, jid, video.title, (video.author && video.author.name) || '');
  return true;
}

module.exports = { handle, handleChoice, searchSong, downloadAudio, bufferToOpusOgg, playSponsor };