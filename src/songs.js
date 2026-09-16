const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const logger = require('./logger');
const store = require('./store');
const { config } = require('./config');
const tts = require('./tts');
const { withTimeout } = require('./human');

// "play <song>" feature: detect a song request, search YouTube, ask the user
// whether they want the mp3 (voice note) or mp4 (video), then download and
// send it as a WhatsApp media message they can play AND save.

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

async function deliver(sock, jid, pend, want) {
  const label = pend.title || 'the song';
  // The sponsor ad goes FIRST (radio-style), then the actual song.
  await playSponsor(sock, jid);
  await sendNote(
    sock,
    jid,
    pend.author
      ? `🎵 *${pend.title}* by _${pend.author}_ — ${want === 'audio' ? 'grabbing the audio, one sec…' : 'grabbing the video, one sec…'}`
      : `🎵 *${pend.title}* — ${want === 'audio' ? 'grabbing the audio, one sec…' : 'grabbing the video, one sec…'}`
  );
  try {
    if (want === 'audio') {
      const ogg = await withTimeout(downloadAudio(pend.id), AUDIO_TIMEOUT + 10000, null);
      if (!ogg || ogg.length > MAX_MEDIA) {
        return sendNote(sock, jid, 'Couldn\'t grab the audio right now (or it\'s too big). Try a different song.');
      }
      await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      record(sock, jid, `🎵 ${pend.title} (voice note)`);
    } else {
      const mp4 = await withTimeout(downloadVideo(pend.id), VIDEO_TIMEOUT + 10000, null);
      if (!mp4 || mp4.length > MAX_MEDIA) {
        return sendNote(sock, jid, 'That video is too big for WhatsApp. Try it as *mp3* instead, or pick a shorter song.');
      }
      await sock.sendMessage(jid, { video: mp4, mimetype: 'video/mp4', caption: `🎵 ${pend.title}\nEnjoy! 🎶` });
      record(sock, jid, `🎵 ${pend.title} (video)`);
    }
  } catch (e) {
    logger.warn('song delivery failed:', e.message || e);
    await sendNote(sock, jid, 'Sorry, the download failed — try again or pick another song.');
  }
}

// Returns true when the message was part of the song flow (so the router does
// NOT also produce a normal AI reply), false when it isn't a song request.
async function handle(sock, jid, text) {
  const t = String(text || '').trim();
  if (!t || jid === 'status@broadcast') return false;

  // 1) A song was suggested earlier and this message picks mp3 or mp4.
  const pend = pending.get(jid);
  if (pend && Date.now() - pend.at < PENDING_TTL) {
    const lower = t.toLowerCase();
    const want =
      lower === 'mp3' || lower === 'audio' || lower === 'voice' || lower === 'voicenote'
        ? 'audio'
        : lower === 'mp4' || lower === 'video'
          ? 'video'
          : '';
    if (want) {
      pending.delete(jid);
      await deliver(sock, jid, pend, want);
      return true;
    }
    // Something else while a choice is pending: drop the choice and treat it
    // as a normal message (could itself be a new song request).
    pending.delete(jid);
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
  await sendNote(
    sock,
    jid,
    `🎵 Found *${video.title}*${video.author && video.author.name ? ' by _' + video.author.name + '_' : ''}.\n` +
      `Send *mp3* to hear it as a voice note, or *mp4* to watch it as a video.`
  );
  return true;
}

module.exports = { handle, searchSong, downloadAudio, bufferToOpusOgg, playSponsor };