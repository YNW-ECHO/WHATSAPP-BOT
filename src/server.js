const http = require('http');
const crypto = require('crypto');
const logger = require('./logger');
const { config } = require('./config');
const session = require('./session');
const store = require('./store');
const tts = require('./tts');

let server = null     // hmm need http server binding to return outside?
let startedAt = Date.now();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function html(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function uid() {
  return crypto.randomBytes(9).toString('hex');
}

const PASSWORD = config.dashPassword;
const sessions = new Map(); // sid -> exp

function authed(req) {
  const ck = (req.headers.cookie || '').match(/sid=([^;]+)/);
  if (!ck) return false;
  const sid = ck[1];
  const s = sessions.get(sid);
  return !!(s && s > Date.now());
}

function setCookie(res, sid) {
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; Max-Age=${60 * 60 * 8}`);
}

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(config.name)}</title>
<style>
:root{--bg:#0b1020;--card:#141b30;--line:#232c4a;--tx:#e8ecf8;--mut:#8b93b0;--acc:#4f8cff;--ok:#29c76a;--bad:#ff5d5d;}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
header{padding:16px 24px;background:var(--card);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:17px;margin:0;font-weight:600}
header .pill{font-size:11px;padding:3px 9px;border-radius:20px;background:var(--line);color:var(--mut)}
header .pill.ok{background:rgba(41,199,106,.15);color:var(--ok)}
nav{display:flex;gap:6px;flex-wrap:wrap;padding:12px 24px 0}
nav a{color:var(--mut);text-decoration:none;font-size:13px;padding:7px 12px;border-radius:8px}
nav a.active{background:var(--acc);color:#fff}
main{padding:18px 24px 40px;max-width:1080px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card .v{font-size:24px;font-weight:700;margin-top:6px}
.card .lab{font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
.mut{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}
input,select,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#0e1530;color:var(--tx)}
button{border-color:var(--acc);color:#fff;cursor:pointer}
button:hover{background:#1c2a55}
a.btn{color:var(--acc);text-decoration:none}
.login-wrap{max-width:380px;margin:14vh auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
.login-wrap form{display:flex;flex-direction:column;gap:12px}
.err{color:var(--bad);font-size:13px;min-height:16px}
@media(max-width:640px){main{padding:14px}nav{padding:10px 14px 0}th,td{padding:7px}}
</style></head><body>
<header><h1>⚡ ${esc(config.name)}</h1><span class="pill" id="conn">…</span><span class="pill" id="clock"></span></header>
${inner}</body></html>`;
}

function layout(navActive, main) {
  const links = [['overview', 'Overview'], ['conversations', 'Conversations'], ['contacts', 'Contacts'],
    ['voice', 'Voice Activity'], ['commands', 'Voice Commands'], ['settings', 'Settings'], ['logs', 'Logs']];
  const nav = '<nav>' + links.map(([k, t]) =>
    `<a href="/${k}" class="${k === navActive ? 'active' : ''}">${t}</a>`).join('') + '</nav>';
  return `<header><h1>⚡ ${esc(config.name)}</h1><span class="pill" id="conn">…</span><span class="pill" id="clock"></span></header>` + nav + `<main>${main}</main>`
    + `<script>setInterval(()=>fetch('/api/state').then(r=>r.json()).then(s=>{` +
    `document.getElementById('conn').textContent=s.connected?'connected':'disconnected';` +
    `document.getElementById('conn').className='pill '+(s.connected?'ok':'');}),5000);` +
    `setInterval(()=>{const d=new Date();document.getElementById('clock').textContent=d.toLocaleTimeString();},1000);</script>`;
}

function startKeepAlive() {
  const url = config.keepAliveUrl;
  if (!url) return;
  const ping = async () => {
    try {
      const headers = config.keepAliveToken ? { Authorization: `Bearer ${config.keepAliveToken}` } : {};
      await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch (e) {}
  };
  setInterval(ping, 5 * 60 * 1000);
  logger.info(`keepalive → ${url} every 5min`);
}

function startServer() {
  const server = http.createServer(handler);
  server.listen(config.port, () => logger.info(`dashboard on :${config.port}`));
  startKeepAlive();
  return server;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  // /health (public, no auth)
  if ((m === 'GET' && (p === '/health' || p === '/' || p.startsWith('/health')))) {
    json(res, 200, {
      ok: true,
      name: config.name,
      connection: session.getState().connection,
      connected: !!session.getState().connected,
      contacts: store.countContacts(),
      uptime: Math.round((Date.now() - startedAt) / 1000),
    });
    return;
  }

  // login
  if (m === 'POST' && p === '/login') {
    const b = JSON.parse(await readBody(req) || '{}');
    if (b.password === PASSWORD) {
      const sid = uid();
      sessions.set(sid, Date.now() + 1000 * 60 * 60 * 8);
      setCookie(res, sid);
      json(res, 200, { ok: true });
    } else {
      json(res, 401, { ok: false, error: 'bad password' });
    }
    return;
  }

  // JSON APIs (require auth except /health)
  if (p.startsWith('/api/')) {
    if (!authed(req)) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }
    if (m === 'GET' && p === '/api/state') { json(res, 200, session.getState()); return; }
    if (m === 'GET' && p === '/api/overview') { json(res, 200, store.overviewStats()); return; }
    if (m === 'GET' && p === '/api/conversations') { json(res, 200, { rows: store.conversationRows() }); return; }
    if (m === 'GET' && p === '/api/contacts') { json(res, 200, { contacts: store.getContacts() }); return; }
    if (m === 'GET' && p === '/api/voice') { json(res, 200, { logs: store.getVoiceLogs(50) }); return; }
    if (m === 'GET' && p === '/api/commands') { json(res, 200, { logs: store.getCommandLogs() }); return; }
    if (m === 'GET' && p === '/api/history') {
      const jid = url.searchParams.get('jid') || '';
      json(res, 200, { history: store.getHistory(jid, 30) });
      return;
    }
    if (m === 'POST' && p === '/api/settings') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (typeof b.global_pause === 'boolean') {
        store.setSetting('global_pause', b.global_pause ? '1' : '0');
        return json(res, 200, { ok: true });
      }
      if (typeof b.system_prompt === 'string') {
        store.setSetting('system_prompt', b.system_prompt);
        return json(res, 200, { ok: true });
      }
      const ch = b.jid ? store.getChat(b.jid) : null;
      if (b.jid && ch) {
        if (typeof b.auto_reply === 'boolean') store.setAutoReply(b.jid, b.auto_reply);
        if (typeof b.muted === 'boolean') store.setMuted(b.jid, b.muted);
        if (typeof b.reply_mode === 'string' && ['text', 'voice', 'off'].includes(b.reply_mode)) store.setReplyMode(b.jid, b.reply_mode);
      }
      json(res, 200, { ok: true });
      return;
    }
    if (m === 'GET' && p === '/api/config') {
      const keys = [
        'aiProvider', 'ai.model', 'name', 'allowGroups', 'voiceAutoReply', 'ttsProvider',
        'ttsVoice', 'styleSampleCount', 'openaiKey', 'anthropicKey', 'elevenLabsKey',
        'googleKey', 'whisperKey', 'minReplySpacing', 'maxReplyDelay', 'port',
      ];
      json(res, 200, {
        ok: true,
        paused: store.isGlobalPaused(),
        system_prompt: store.getSetting('system_prompt', ''),
        keys: {
          openai: !!config.openaiKey ? 'set' : 'unset',
          anthropic: !!config.anthropicKey ? 'set' : 'unset',
          gemini: !!config.geminiKey ? 'set' : 'unset',
          groq: !!config.groqKey ? 'set' : 'unset',
          whisper: !!config.whisperKey ? 'set' : 'unset',
          google: !!config.googleKey ? 'set' : 'unset',
          elevenlabs: !!config.elevenLabsKey ? 'set' : 'unset',
          ffmpeg: tts.ffmpegAvailable() ? 'available' : 'missing',
        },
        provider: config.aiProvider,
        ttsProvider: config.ttsProvider,
      });
      return;
    }
    if (m === 'GET' && p === '/api/style') {
      json(res, 200, { ok: true, samples: store.getStyleSamples(50) });
      return;
    }
    if (m === 'POST' && p === '/api/style') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.text && String(b.text).trim()) {
        store.addStyleSample(b.jid || '', b.text);
        json(res, 200, { ok: true });
      } else json(res, 400, { ok: false, error: 'text required' });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
    return;
  }

  // pages (require auth)
  if (!authed(req)) {
    html(res, 200, page('Login', `
      <div class="login-wrap">
        <h2>Sign in</h2>
        <p class="mut" style="margin-top:-4px">Dashboard for ${esc(config.name)}</p>
        <form id="f">
          <input type="password" id="pw" placeholder="Password" autofocus>
          <button type="submit">Unlock</button>
          <div class="err" id="err"></div>
        </form>
        <script>
        document.getElementById('f').onsubmit=async e=>{e.preventDefault();
          const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
          if(r.ok){location.href='/overview';}else{document.getElementById('err').textContent='Wrong password';}};
        </script>
      </div>`));
    return;
  }

  if (p === '/overview' || p === '') {
    html(res, 200, layout('overview', `
      <h2>Overview</h2>
      <div class="grid" id="cards"></div>
      <script>
      fetch('/api/overview').then(r=>r.json()).then(o=>{
        const items=[['Total messages','total'],['Replies sent','replies'],['Active chats','activeChats'],
          ['Voice commands','voiceCmds'],['Voice replies','voiceCmdsCnt'],['Statuses viewed','statuses'],
          ['Contacts','contacts'],['Uptime (min)','uptime']];
        document.getElementById('cards').innerHTML=items.map(([l,k])=>
          '<div class="card"><div class="lab">'+l+'</div><div class="v">'+(o[k]==null?0:o[k])+'</div></div>').join('');
      });
      </script>`));
    return;
  }

  if (p === '/conversations') {
    html(res, 200, layout('conversations', `
      <h2>Conversations</h2>
      <table><thead><tr><th>Contact</th><th>JID</th><th>Auto</th><th>Muted</th><th>Last msg</th><th>Messages today</th><th>Action</th></tr></thead>
      <tbody id="rows"></tbody></table>
      <script>
      fetch('/api/conversations').then(r=>r.json()).then(d=>{
        document.getElementById('rows').innerHTML=d.rows.map(r=>
          '<tr><td>'+(r.name||'—')+'</td><td class="mut">'+r.jid+'</td><td>'+(r.auto_reply?'<span class="ok">on</span>':'<span class="mut">off</span>')+'</td>'+
          '<td>'+(r.muted?'<span class="bad">muted</span>':'—')+'</td><td>'+(r.last_text||'')+'</td><td>'+(r.msgs_today||0)+'</td>'+
          '<td><a class="btn" href="/logs?jid='+encodeURIComponent(r.jid)+'">logs</a></td></tr>').join('')||'<tr><td colspan=7 class="mut">No conversations yet.</td></tr>';
      });
      </script>`));
    return;
  }

  if (p === '/contacts') {
    html(res, 200, layout('contacts', `
      <h2>Contacts</h2>
      <table><thead><tr><th>Name</th><th>JID</th></tr></thead><tbody id="rows"></tbody></table>
      <script>
      fetch('/api/contacts').then(r=>r.json()).then(d=>{
        document.getElementById('rows').innerHTML=d.contacts.map(c=>'<tr><td>'+(c.name||'—')+'</td><td class="mut">'+c.jid+'</td></tr>').join('')||'<tr><td colspan=2 class="mut">No contacts saved.</td></tr>';
      });
      </script>`));
    return;
  }

  if (p === '/voice') {
    html(res, 200, layout('voice', `
      <h2>Voice Activity</h2>
      <table><thead><tr><th>Contact</th><th>Dir</th><th>Transcript</th><th>Time</th></tr></thead><tbody id="rows"></tbody></table>
      <script>
      fetch('/api/voice').then(r=>r.json()).then(d=>{
        document.getElementById('rows').innerHTML=d.logs.map(v=>
          '<tr><td>'+(v.name||v.jid)+'</td><td>'+(v.direction==='in'?'<span class="ok">in</span>':'<span class="bad">out</span>')+'</td>'+
          '<td>'+(v.transcript||'')+'</td><td class="mut">'+new Date(v.ts).toLocaleTimeString()+'</td></tr>').join('')||'<tr><td colspan=4 class="mut">No voice notes yet.</td></tr>';
      });
      </script>`));
    return;
  }

  if (p === '/commands') {
    html(res, 200, layout('commands', `
      <h2>Voice Commands Log</h2>
      <table><thead><tr><th>Contact</th><th>Type</th><th>Detail</th><th>Time</th></tr></thead><tbody id="rows"></tbody></table>
      <script>
      fetch('/api/commands').then(r=>r.json()).then(d=>{
        document.getElementById('rows').innerHTML=d.logs.map(c=>
          '<tr><td>'+(c.name||c.jid)+'</td><td>'+(c.kind||'')+'</td><td>'+(c.detail||'')+'</td><td class="mut">'+new Date(c.ts).toLocaleTimeString()+'</td></tr>').join('')||'<tr><td colspan=4 class="mut">No command logs yet.</td></tr>';
      });
      </script>`));
    return;
  }

  if (p === '/settings') {
    html(res, 200, layout('settings', `
      <h2>Settings</h2>
      <div class="grid">
        <div class="card"><div class="lab">Global pause</div><button id="pause" onclick="togglePause()">…</button></div>
        <div class="card"><div class="lab">AI provider</div><div class="v" id="prov">…</div></div>
        <div class="card"><div class="lab">TTS</div><div class="v" id="tts">…</div></div>
        <div class="card"><div class="lab">ffmpeg</div><div class="v" id="ff">…</div></div>
      </div>
      <h3 style="margin-top:22px">API keys</h3>
      <table><thead><tr><th>Key</th><th>Status</th></tr></thead><tbody id="keys"></tbody></table>
      <h3 style="margin-top:22px">Per-chat settings</h3>
      <p class="mut">Auto-reply, mute, and reply mode (text / voice / off).</p>
      <table><thead><tr><th>Contact</th><th>JID</th><th>Auto-reply</th><th>Muted</th><th>Reply mode</th></tr></thead><tbody id="rows"></tbody></table>
      <h3 style="margin-top:22px">System prompt (optional override)</h3>
      <textarea id="sp" rows="5" style="width:100%"></textarea><br>
      <button onclick="saveSP()">Save system prompt</button>
      <h3 style="margin-top:22px">Style samples (owner's real messages used for few-shot style)</h3>
      <p class="mut">These power the style engine. Add your own messages to teach the bot your voice.</p>
      <input id="ns" placeholder="Paste one of your own WhatsApp messages…" style="width:60%">
      <button onclick="addSample()">Add sample</button>
      <table><thead><tr><th>#</th><th>Sample</th><th>Time</th></tr></thead><tbody id="samp"></tbody></table>
      <script>
      function cfg(){return fetch('/api/config').then(r=>r.json());}
      async function draw(){
        const c=await cfg();
        document.getElementById('pause').textContent=c.paused?'▶ Resume':'❚❚ Pause';
        document.getElementById('pause').className=c.paused?'bad':'ok';
        document.getElementById('prov').textContent=c.provider;
        document.getElementById('tts').textContent=c.ttsProvider;
        document.getElementById('ff').textContent=c.keys.ffmpeg;
        document.getElementById('sp').value=c.system_prompt||'';
        document.getElementById('keys').innerHTML=Object.entries(c.keys).filter(([k])=>k!=='ffmpeg').map(([k,v])=>'<tr><td>'+k+'</td><td class="'+(v==='set'?'ok':'mut')+'">'+v+'</td></tr>').join('');
      }
      function kv(jid,key,val){fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jid,[key]:val})}).then(draw);}
      async function togglePause(){const c=await cfg();fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({global_pause:!c.paused})}).then(draw);}
      function saveSP(){const sp=document.getElementById('sp').value;fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({system_prompt:sp})}).then(draw);}
      function addSample(){const t=document.getElementById('ns').value;if(!t)return;fetch('/api/style',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})}).then(()=>{document.getElementById('ns').value='';loadSamples();});}
      function row(r){
        return '<tr><td>'+(r.name||'—')+'</td><td class="mut">'+r.jid+'</td>'+
          '<td><button class="'+(r.auto_reply?'ok':'mut')+'" onclick="kv(\\''+r.jid.replace(/'/g,"\\\\'")+'\\','auto_reply',!'+(!!r.auto_reply)+')">'+(r.auto_reply?'on':'off')+'</button></td>'+
          '<td><button class="'+(r.muted?'bad':'mut')+'" onclick="kv(\\''+r.jid.replace(/'/g,"\\\\'")+'\\','muted',!'+(!!r.muted)+')">'+(r.muted?'muted':'live')+'</button></td>'+
          '<td><select onchange="kv(\\''+r.jid.replace(/'/g,"\\\\'")+'\\','reply_mode',this.value)">'+
            ['text','voice','off'].map(mm=>'<option value="'+mm+'" '+(r.reply_mode===mm?'selected':'')+'>'+mm+'</option>').join('')+
          '</select></td></tr>';
      }
      function loadSamples(){fetch('/api/style').then(r=>r.json()).then(d=>{document.getElementById('samp').innerHTML=d.samples.map((s,i)=>'<tr><td>'+(i+1)+'</td><td>'+s.text+'</td><td class="mut">'+new Date(s.ts).toLocaleString()+'</td></tr>').join('')||'<tr><td colspan=3 class="mut">No samples yet.</td></tr>';});}
      fetch('/api/conversations').then(r=>r.json()).then(d=>{document.getElementById('rows').innerHTML=d.rows.map(row).join('');});
      loadSamples(); draw(); setInterval(draw,15000);
      </script>`));
    return;
  }

  if (p === '/logs') {
    const jid = url.searchParams.get('jid') || '';
    html(res, 200, layout('logs', `
      <h2>Logs</h2>
      ${jid ? `<p class="mut">Chat: ${esc(jid)}</p>` : '<p class="mut">Recent history across chats.</p>'}
      <table><thead><tr><th>Role</th><th>Text</th><th>Time</th></tr></thead><tbody id="rows"></tbody></table>
      <script>
      fetch('/api/history?jid='+encodeURIComponent('${esc(jid)}')).then(r=>r.json()).then(d=>{
        document.getElementById('rows').innerHTML=d.history.map(h=>
          '<tr><td>'+(h.role==='user'?'<span class="ok">user</span>':'<span class="bad">bot</span>')+'</td><td>'+(h.text||'')+'</td><td class="mut">'+new Date(h.ts).toLocaleTimeString()+'</td></tr>').join('')||'<tr><td colspan=3 class="mut">No history.</td></tr>';
      });
      </script>`));
    return;
  }

  html(res, 404, 'not found');
}

module.exports = { startServer };
