const http = require('http');
const crypto = require('crypto');
const logger = require('./logger');
const { config } = require('./config');
const session = require('./session');
const store = require('./store');
const tts = require('./tts');
const bot = require('./bot');
const trainer = require('./trainer');

let startedAt = Date.now();
const PASSWORD = config.dashPassword;
const sessions = new Map();

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
    req.on('data', (c) => { d += c; if (d.length > 20e6) req.destroy(); });
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

function authed(req) {
  const ck = (req.headers.cookie || '').match(/sid=([^;]+)/);
  if (!ck) return false;
  const s = sessions.get(ck[1]);
  return !!(s && s > Date.now());
}

function setCookie(res, sid) {
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; Max-Age=${60 * 60 * 8}`);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, '');
}

async function geoLookup(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('::')) return '';
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=query,city,regionName,country,status`, {
      signal: AbortSignal.timeout(4000),
    });
    const j = await r.json();
    if (j.status === 'success') {
      return [j.city, j.regionName, j.country].filter(Boolean).join(', ');
    }
  } catch (e) {}
  return '';
}

function bootTime() {
  return Math.round((Date.now() - startedAt) / 1000);
}

/* ----------------------------- UI shell ----------------------------- */

const CSS = `:root{--bg:#0a0e1a;--card:#111827;--line:#1f2937;--tx:#e5e7eb;--mut:#94a3b8;--acc:#6366f1;--ok:#22c55e;--bad:#ef4444;--warn:#f59e0b}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--tx)}
a{color:var(--acc);text-decoration:none}
.top{display:flex;align-items:center;gap:10px;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
.top h1{font-size:16px;margin:0}
.pill{font-size:11px;padding:3px 10px;border-radius:20px;background:var(--line);color:var(--mut)}
.pill.ok{background:rgba(34,197,94,.12);color:var(--ok)}
.pill.bad{background:rgba(239,68,68,.12);color:var(--bad)}
.spacer{flex:1}
nav{display:flex;gap:4px;padding:10px 20px 0;overflow-x:auto}
nav a{color:var(--mut);font-size:13px;padding:7px 13px;border-radius:8px;white-space:nowrap}
nav a.active{background:var(--acc);color:#fff}
main{padding:16px 20px 60px;max-width:1120px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card .v{font-size:22px;font-weight:700;margin-top:4px}
.card .lab{font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.4px}
.mut{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
button,input,select,textarea{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:#0b1220;color:var(--tx)}
button{cursor:pointer;border-color:var(--acc)}
button:hover{filter:brightness(1.2)}
button.primary{background:var(--acc);color:#fff;border-color:var(--acc)}
button.clear{border-color:var(--bad);color:var(--bad)}
.wrap{display:flex;flex-direction:column;gap:12px}
.code{background:#0b1220;border:1px dashed var(--line);border-radius:12px;padding:18px;text-align:center}
.code .big{font-size:30px;letter-spacing:8px;font-weight:800;color:var(--acc);font-family:ui-monospace,monospace;margin:8px 0}
.err{color:var(--bad);font-size:13px;min-height:16px}
.sm{font-size:12px;color:var(--mut);line-height:1.5}
.banner{border:1px solid var(--warn);border-radius:10px;padding:12px 14px;margin:12px 0;background:rgba(245,158,11,.08);color:var(--tx)}
.banner.ok{border-color:var(--ok);background:rgba(34,197,94,.08)}
/* modal */
.ovl{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:50;padding:16px}
.ovl.show{display:flex}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:520px;width:100%;padding:22px}
.modal h3{margin:0 0 10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.login-wrap{max-width:400px;margin:12vh auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.login-wrap h2{margin-top:0}
.login-wrap form{display:flex;flex-direction:column;gap:12px}
@media(max-width:640px){main{padding:12px}.code .big{font-size:22px;letter-spacing:4px}}`;

function modalRelink() {
  return `<div class="ovl" id="relinkOvl"><div class="modal">
<h3>🔗 Re-link WhatsApp</h3>
<div id="relinkBody">
<p class="sm">We'll log this device out, reset the session, and generate a fresh link so you (or anyone) can log the bot's WhatsApp in again.</p>
<p class="sm">Opening WhatsApp: <b id="rlNumber">Settings → Linked devices → Link a device</b></p>
<div class="code" id="rlCodeWrap" style="display:none">
  <div class="lab">ENTER THIS CODE (or scan the QR from the console logs):</div>
  <div class="big" id="rlCode"></div>
</div>
<div class="row"><button id="rlBtn" class="primary">Generate new link</button><span class="sm" id="rlStatus"></span></div>
</div></div></div>`;
}

function layout(navActive, main) {
  const links = [['overview', 'Overview'], ['chats', 'Chats'], ['devices', 'Devices & Logins'], ['training', 'Training'], ['settings', 'Settings']];
  const nav = '<nav>' + links.map(([k, t]) =>
    `<a href="/${k}" class="${k === navActive ? 'active' : ''}">${t}</a>`).join('') + '</nav>';
  return `<header class="top">
<h1>⚡ ${esc(config.name)}</h1>
<span class="pill" id="conn">…</span><span class="pill" id="num">…</span><span class="pill" id="clock"></span>
<div class="spacer"></div>
<button id="relinkBtn" class="clear">🔗 Re-link WhatsApp</button>
</header>
${nav}
<script>
const $=q=>document.getElementById(q);
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function qs(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function j(u,o){const r=await fetch(u,o);return r.json();}
function refreshState(){fetch('/api/state').then(r=>r.json()).then(s=>{
  const c=$('conn'),n=$('num');
  c.textContent=s.connected?'connected':(s.relinkPending?'re-link in progress…':s.connection);
  c.className='pill '+(s.connected?'ok':(s.relinkPending?'':'bad'));
  n.textContent=s.number||(s.pairingCode?('code '+s.pairingCode):'not linked');
}).catch(()=>{});}
function relinkModal(){
  $('relinkBody').style.display='block';
  $('rlBtn').style.display='inline-block';
  $('rlCodeWrap').style.display='none';
  $('rlStatus').textContent='';
  $('rlNumber').textContent=configOwner||'';
  $('relinkOvl').classList.add('show');
}
let configOwner='';
fetch('/api/state').then(r=>r.json()).then(s=>{configOwner=s.ownerPhone;if(s.ownerPhone)$('rlNumber').textContent=s.ownerPhone;});
$('relinkBtn').onclick=()=>{
  if(!confirm('Reset the WhatsApp session and generate a new pairing code?'))return;
  $('relinkOvl').classList.add('show');
  $('rlBtn').style.display='none';
  $('rlStatus').textContent='Resetting session… (one moment)';
  $('rlCodeWrap').style.display='none';
  j('/api/relink',{method:'POST'}).then(d=>{
    if(d.code){$('rlCode').textContent=d.code;$('rlCodeWrap').style.display='block';$('rlStatus').textContent='Open WhatsApp → Linked devices → Link with phone number.';}
    else if(d.error){$('rlStatus').textContent='Error: '+d.error;}
    else $('rlStatus').textContent='No code yet — watch the console logs for the QR.';
    refreshState();
  }).catch(e=>{$('rlStatus').textContent='Error: '+e.message;});
};
setInterval(()=>{refreshState();const d=new Date();$('clock').textContent=d.toLocaleTimeString();},4000);
refreshState();
</script>
<main>${main}</main>
${modalRelink()}`;
}

/* ----------------------------- pages ----------------------------- */

function loginPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${esc(config.name)}</title><style>${CSS}</style></head><body>
<div class="login-wrap">
<div style="font-size:34px">⚡</div><h2>${esc(config.name)} admin console</h2>
<p class="mut" style="margin-top:-6px">Enter the admin password to manage the WhatsApp bot.</p>
<form id="f">
<input type="password" id="pw" placeholder="Admin password" autocomplete="current-password" autofocus>
<button type="submit" class="primary">Unlock console</button>
<div class="err" id="err"></div>
</form>
<div class="sm">Every successful login is recorded with the device, IP and location.</div>
</div>
<script>
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
  const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  const d=await r.json();
  if(r.ok){location.href='/overview';}else{document.getElementById('pw').value='';document.getElementById('err').textContent=d.error||'Wrong password';}};
</script></body></html>`;
}

function overviewPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overview — ${esc(config.name)}</title><style>${CSS}</style></head><body>
${layout('overview', `
<div class="banner" id="connBanner" style="display:none"></div>
<div class="grid" id="cards"></div>
<h3 style="margin-top:22px">Live console</h3>
<div class="card"><div class="sm" id="consoleText">Loading…</div></div>
<script>
function cnum(n){return n==null?'—':n;}
fetch('/api/overview').then(r=>r.json()).then(o=>{
  document.getElementById('cards').innerHTML=[
    ['Total messages today','total'],['AI replies sent','replies'],['Chats active','activeChats'],
    ['Statuses viewed','statuses'],['Reactions sent','reactions'],['Contacts','contacts'],['Uptime','uptime']]
    .map(([l,k])=>k==='uptime'
      ?'<div class="card"><div class="lab">'+l+'</div><div class="v">'+cnum(o.minutes)+'m</div></div>'
      :'<div class="card"><div class="lab">'+l+'</div><div class="v">'+cnum(o[k])+'</div></div>').join('');
});
function renderState(){
  fetch('/api/state').then(r=>r.json()).then(s=>{
    const b=document.getElementById('connBanner');
    if(s.connected){b.style.display='none';}
    else{
      b.style.display='block';
      b.textContent = s.relinkPending ? 'Re-linking… watch for a new code.' :
        (s.pairingCode ? 'NOT linked — open WhatsApp → Settings → Linked devices → "Link with phone number" and enter: '+s.pairingCode :
        (s.connection==='connecting' ? 'Connecting to WhatsApp… this usually needs a fresh link after a redeploy.' : 'Disconnected. Click "Re-link WhatsApp" to get a new code.'));
      b.className='banner '+(s.relinkPending?'':'');
    }
    document.getElementById('consoleText').innerHTML=
      '<b>Connection:</b> '+(s.connected?'<span class="ok">online</span>':'<span class="bad">'+esc(s.connection)+'</span>')+
      '<br><b>Number:</b> '+esc(s.number||'—')+
      '<br><b>Device:</b> '+esc(s.device||'—')+
      '<br><b>Pairing code:</b> <span class="code-inline">'+esc(s.pairingCode||'—')+'</span>'+
      '<br><b>Contacts saved:</b> '+cnum(s.contacts)+
      '<br><b>Global pause:</b> '+(s.paused?'<span class="bad">ON</span>':'<span class="ok">off</span>')+
      '<br><b>Status reactions:</b> '+(s.statusReacts?'<span class="ok">on</span>':'<span class="mut">off</span>');
  });
}
setInterval(renderState,4000);
renderState();
</script>`)}</body></html>`;
}

function chatsPage() {
  return `<div class="card"><div class="row">
<input id="q" placeholder="Filter by name or number…" style="flex:1">
<button onclick="load()">Filter</button></div>
<table><thead><tr><th>Contact</th><th>JID</th><th>Auto</th><th>Muted</th><th>Last message</th><th>Today</th><th></th></tr></thead>
<tbody id="rows"></tbody></table></div>
<script>
function load(){
  fetch('/api/conversations').then(r=>r.json()).then(d=>{
    const q=(document.getElementById('q').value||'').toLowerCase();
    const rows=d.rows.filter(r=>!q||(r.name||'').toLowerCase().includes(q)||r.jid.includes(q));
    document.getElementById('rows').innerHTML=rows.map(r=>'<tr>'+
      '<td>'+esc(r.name||'—')+'</td><td class="mut">'+esc(r.jid)+'</td>'+
      '<td><button class="'+(r.auto_reply?'ok':'mut')+'" onclick="auto(&quot;'+qs(r.jid)+'&quot;,!'+(!!r.auto_reply)+')">'+(r.auto_reply?'on':'off')+'</button></td>'+
      '<td><button class="'+(r.muted?'bad':'mut')+'" onclick="mute(&quot;'+qs(r.jid)+'&quot;,!'+(!!r.muted)+')">'+(r.muted?'muted':'live')+'</button></td>'+
      '<td class="mut">'+esc(String(r.last_text||'').slice(0,90))+'</td><td>'+(r.msgs_today||0)+'</td>'+
      '<td><a href="/logs?jid='+encodeURIComponent(r.jid)+'">history</a></td></tr>').join('')||'<tr><td colspan=7 class="mut">No conversations yet.</td></tr>';
  });
}
function auto(j,v){fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jid:j,auto_reply:v})}).then(load);}
function mute(j,v){fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jid:j,muted:v})}).then(load);}
load();
</script>`;
}

function devicesPage() {
  return `<div class="card">
<div class="row"><h3 style="margin:0;flex:1">Device & login audit</h3>
<button class="clear" onclick="clearLogins()">Clear log</button></div>
<p class="sm">Shows the linked WhatsApp session and every admin dashboard login (IP + approx. location). WhatsApp does not expose GPS of linked devices.</p>
<table><thead><tr><th>Type</th><th>Number</th><th>Device</th><th>IP</th><th>Location</th><th>Detail</th><th>When</th></tr></thead>
<tbody id="rows"></tbody></table></div>
<script>
function fmt(ts){const d=new Date(ts);return d.toLocaleDateString()+' '+d.toLocaleTimeString();}
function load(){fetch('/api/logins').then(r=>r.json()).then(d=>{
  document.getElementById('rows').innerHTML=d.logins.map(x=>'<tr>'+
    '<td>'+(x.kind==='whatsapp'?'<span class="pill ok">WhatsApp</span>':'<span class="pill warn">Dashboard</span>')+'</td>'+
    '<td>'+esc(x.number||'—')+'</td><td>'+esc(x.device||'—')+'</td>'+
    '<td class="mut">'+esc(x.ip||'—')+'</td><td>'+esc(x.location||'—')+'</td>'+
    '<td class="mut">'+esc(x.detail||'')+'</td><td class="mut">'+fmt(x.ts)+'</td></tr>').join('')||'<tr><td colspan=7 class="mut">No logins recorded yet.</td></tr>';
});}
function clearLogins(){if(!confirm('Clear the whole login audit log?'))return;fetch('/api/logins/clear',{method:'POST'}).then(load);}
load();
</script>`;
}

function trainingPage() {
  return `<div class="grid">
<div class="card">
  <div class="lab">Teach the bot to sound like you</div>
  <p class="sm">Paste your own real WhatsApp messages below, or <b>upload a full chat export</b>. The bot learns your
  exact tone, slang and language-mixing and uses it as few-shot style for every reply.</p>
  <textarea id="txt" rows="4" style="width:100%" placeholder="e.g. niaje boss, ata kazi iko poa tu"></textarea>
  <div class="row"><button class="primary" onclick="addManual()">Add sample</button></div>
  <hr style="border-color:var(--line)">
  <div class="lab">Upload a WhatsApp export (.txt)</div>
  <p class="sm">WhatsApp → chat → More options → Export chat → without media. Then tell us how <b>you</b> appear in it.</p>
  <div class="row"><input id="owner" placeholder="Your name or number in export" style="flex:1">
  <input type="file" id="file" accept=".txt"></div>
  <div class="row"><button class="primary" onclick="upload()">Import chat</button><span class="sm" id="upStatus"></span></div>
  <div class="err" id="err"></div>
</div>
<div class="card">
  <div class="row"><div class="lab" style="flex:1">Training samples used by the AI</div>
  <button class="clear" onclick="clearAll()">Clear all</button></div>
  <table><thead><tr><th>#</th><th>Sample</th><th>When</th><th></th></tr></thead>
  <tbody id="samp"></tbody></table>
</div></div>
<script>
function load(){fetch('/api/train').then(r=>r.json()).then(d=>{
  document.getElementById('samp').innerHTML=d.samples.map(s=>'<tr><td>'+(s.id)+'</td><td>'+esc(s.text)+'</td>'+
    '<td class="mut">'+new Date(s.ts).toLocaleString()+'</td><td><a href="javascript:del('+s.id+')">delete</a></td></tr>').join('')
    ||'<tr><td colspan=4 class="mut">No samples yet — the bot learns as you add or import.</td></tr>';
});}
function addManual(){const t=document.getElementById('txt').value;if(!t.trim())return;
  fetch('/api/train',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})}).then(()=>{document.getElementById('txt').value='';load();});}
function upload(){
  const f=document.getElementById('file').files[0];
  if(!f){document.getElementById('err').textContent='Pick the exported .txt file first.';return;}
  const owner=document.getElementById('owner').value.trim();
  document.getElementById('upStatus').textContent='Importing…';
  f.text().then(txt=>fetch('/api/train/upload',{method:'POST',headers:{'content-type':'text/plain','x-owner':owner},body:txt}))
    .then(r=>r.json()).then(d=>{
      document.getElementById('upStatus').textContent='Matched '+d.matched+' of your messages → added '+d.added+' samples.';
      load();
    }).catch(e=>document.getElementById('err').textContent='Import failed: '+e.message);
}
function del(id){fetch('/api/train/'+id,{method:'DELETE'}).then(load);}
function clearAll(){if(!confirm('Delete ALL training samples?'))return;fetch('/api/train/clear',{method:'POST'}).then(load);}
load();
</script>`;
}

function settingsPage() {
  return `<div class="grid">
<div class="card">
  <div class="lab">Behaviour</div>
  <div class="row"><b style="flex:1">Global pause (stop all replies)</b><button id="pause" onclick="toggle('global_pause')">…</button></div>
  <div class="row"><b style="flex:1">React/like statuses after viewing</b><button id="reacts" onclick="toggle('status_react')">…</button></div>
  <div class="row"><b style="flex:1">Reply to voice notes with voice</b><button id="voice" onclick="toggle('voice_auto')">…</button></div>
</div>
<div class="card">
  <div class="lab">AI & integrations</div>
  <table><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody id="keys"></tbody></table>
  <p class="sm">Provider: <b id="prov">…</b> · TTS: <b id="tts">…</b></p>
</div>
</div>
<div class="card">
  <div class="lab">System prompt override (optional)</div>
  <textarea id="sp" rows="5" style="width:100%;margin-top:8px"></textarea>
  <div class="row"><button class="primary" onclick="saveSP()">Save system prompt</button></div>
</div>
<div class="err" id="err"></div>
<script>
function cfg(){return fetch('/api/config').then(r=>r.json());}
function draw(){
  cfg().then(c=>{
    document.getElementById('pause').textContent=c.paused?'❚❚ Paused':'▶ Running';
    document.getElementById('pause').className=c.paused?'clear':'primary';
    document.getElementById('reacts').textContent=c.statusReacts?'on':'off';
    document.getElementById('reacts').className=c.statusReacts?'primary':'';
    document.getElementById('voice').textContent=c.voiceAuto?'on':'off';
    document.getElementById('voice').className=c.voiceAuto?'primary':'';
    document.getElementById('prov').textContent=c.provider;
    document.getElementById('tts').textContent=c.ttsProvider;
    document.getElementById('sp').value=c.system_prompt||'';
    document.getElementById('keys').innerHTML=Object.entries(c.keys).filter(([k])=>k!=='ffmpeg').map(([k,v])=>
      '<tr><td>'+k+'</td><td class="'+(v==='set'?'ok':'mut')+'">'+v+'</td></tr>').join('')+
      '<tr><td>ffmpeg</td><td class="'+(c.keys.ffmpeg==='available'?'ok':'bad')+'">'+c.keys.ffmpeg+'</td></tr>';
  });
}
function toggle(k){return cfg().then(c=>{
  const v = k==='global_pause' ? !c.paused : k==='status_react' ? !c.statusReacts : k==='voice_auto' ? !c.voiceAuto : false;
  return fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({[k]:v})});
}).then(draw);}
function saveSP(){fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({system_prompt:document.getElementById('sp').value})}).then(draw);}
setInterval(draw,15000);draw();
</script>`;
}

function logsPage(jid) {
  const q = encodeURIComponent(jid).replace(/'/g, '%27').replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/~/g, '%7E');
  return `<div class="card"><div class="row"><h3 style="margin:0;flex:1">Chat history${jid ? ' — '+esc(jid) : ''}</h3></div>
<table><thead><tr><th>Role</th><th>Text</th><th>When</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
fetch('/api/history?jid=${q}').then(r=>r.json()).then(d=>{
  document.getElementById('rows').innerHTML=d.history.map(h=>'<tr><td>'+(h.role==='user'?'<span class="ok">user</span>':'<span class="bad">bot</span>')+'</td>'+
    '<td>'+esc(h.text)+'</td><td class="mut">'+new Date(h.ts).toLocaleString()+'</td></tr>').join('')||'<tr><td colspan=3 class="mut">No history.</td></tr>';
});
</script>`;
}

/* ----------------------------- server ----------------------------- */

function startKeepAlive() {
  const url = config.keepAliveUrl;
  if (!url) return;
  const ping = async () => {
    try {
      const headers = config.keepAliveToken ? { Authorization: `Bearer ${config.keepAliveToken}` } : {};
      await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch (e) {}
  };
  setInterval(ping, 30 * 1000);
  logger.info(`keepalive → ${url} every 30s`);
}

function startServer() {
  store.init();
  const server = http.createServer(handler);
  server.listen(config.port, () => logger.info(`dashboard on :${config.port}`));
  startKeepAlive();
  return server;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && (p === '/' || p === '/health' || p.startsWith('/health'))) {
    json(res, 200, {
      ok: true, name: config.name,
      connected: !!session.getState().connected,
      connection: session.getState().connection,
      contacts: store.countContacts(),
      number: session.getState().number || '',
      uptime: bootTime(),
    });
    return;
  }

  // admin login (public) — audited with IP + location
  if (m === 'POST' && p === '/login') {
    const b = JSON.parse(await readBody(req) || '{}');
    if (b.password === PASSWORD) {
      const sid = uid();
      sessions.set(sid, Date.now() + 1000 * 60 * 60 * 8);
      setCookie(res, sid);
      const ip = clientIp(req);
      const location = await geoLookup(ip);
      (async () => {
        try {
          store.addDeviceLogin({
            kind: 'dashboard', number: config.dashUser, device: req.headers['user-agent'] || '',
            ip, location, detail: 'Admin dashboard login',
          });
        } catch (e) {}
      })();
      json(res, 200, { ok: true });
    } else {
      json(res, 401, { ok: false, error: 'bad password' });
    }
    return;
  }

  if (p === '/login') { html(res, 200, loginPage()); return; }

  if (p.startsWith('/api/')) {
    if (!authed(req)) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }

    if (m === 'GET' && p === '/api/state') {
      const s = session.getState();
      json(res, 200, {
        ok: true, name: config.name,
        ...s,
        contacts: store.countContacts(),
        uptime: bootTime(),
        paused: store.isGlobalPaused(),
        statusReacts: store.getSetting('status_react', config.statusReacts ? '1' : '0') === '1',
        voiceAuto: store.getSetting('voice_auto', config.voiceAutoReply ? '1' : '0') === '1',
        ownerPhone: config.ownerPhone || '',
      });
      return;
    }

    if (m === 'POST' && p === '/api/relink') {
      const r = await bot.relink();
      json(res, 200, r);
      return;
    }

    if (m === 'GET' && p === '/api/logins') { json(res, 200, { logins: store.getDeviceLogins(200) }); return; }
    if (m === 'POST' && p === '/api/logins/clear') { store.clearDeviceLogins(); json(res, 200, { ok: true }); return; }
    if (m === 'GET' && p === '/api/overview') {
      const o = store.overviewStats();
      const reactions = (() => {
        try { return store.countCommandLogsToday('reaction'); } catch (e) { return 0; }
      })();
      json(res, 200, { ...o, reactions, minutes: o.uptime });
      return;
    }
    if (m === 'GET' && p === '/api/conversations') { json(res, 200, { rows: store.conversationRows() }); return; }
    if (m === 'GET' && p === '/api/history') {
      const jid = url.searchParams.get('jid') || '';
      json(res, 200, { history: store.getHistory(jid, 40) });
      return;
    }
    if (m === 'GET' && p === '/api/contacts') { json(res, 200, { contacts: store.getContacts() }); return; }

    if (m === 'GET' && p === '/api/train') { json(res, 200, { samples: store.getStyleSamples(100) }); return; }
    if (m === 'POST' && p === '/api/train') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.text && String(b.text).trim()) {
        trainer.addManual(b.text);
        json(res, 200, { ok: true });
      } else json(res, 400, { ok: false, error: 'text required' });
      return;
    }
    if (m === 'POST' && p === '/api/train/upload') {
      const raw = await readBody(req);
      const owner = req.headers['x-owner'] || config.ownerPhone || req.headers['x-filename'] || '';
      const r = trainer.importExport(raw, owner);
      json(res, 200, { ok: true, ...r });
      return;
    }
    if (m === 'DELETE' && /^\/api\/train\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      try { store.deleteStyleSample(id); json(res, 200, { ok: true }); }
      catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return;
    }
    if (m === 'POST' && p === '/api/train/clear') {
      store.clearStyleSamples();
      json(res, 200, { ok: true });
      return;
    }

    if (m === 'POST' && p === '/api/settings') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (typeof b.global_pause === 'boolean') store.setSetting('global_pause', b.global_pause ? '1' : '0');
      if (typeof b.status_react === 'boolean') store.setSetting('status_react', b.status_react ? '1' : '0');
      if (typeof b.voice_auto === 'boolean') store.setSetting('voice_auto', b.voice_auto ? '1' : '0');
      if (typeof b.system_prompt === 'string') store.setSetting('system_prompt', b.system_prompt);
      const ch = b.jid ? store.getChat(b.jid) : null;
      if (ch) {
        if (typeof b.auto_reply === 'boolean') store.setAutoReply(b.jid, b.auto_reply);
        if (typeof b.muted === 'boolean') store.setMuted(b.jid, b.muted);
        if (typeof b.reply_mode === 'string' && ['text', 'voice', 'off'].includes(b.reply_mode)) store.setReplyMode(b.jid, b.reply_mode);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (m === 'GET' && p === '/api/config') {
      json(res, 200, {
        ok: true,
        paused: store.isGlobalPaused(),
        statusReacts: store.getSetting('status_react', config.statusReacts ? '1' : '0') === '1',
        voiceAuto: store.getSetting('voice_auto', config.voiceAutoReply ? '1' : '0') === '1',
        system_prompt: store.getSetting('system_prompt', ''),
        provider: config.aiProvider,
        ttsProvider: config.ttsProvider,
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
      });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (!authed(req)) { html(res, 200, loginPage()); return; }

  const navPage = (navActive, body) => html(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${navActive} — ${esc(config.name)}</title><style>${CSS}</style></head><body>${layout(navActive, body)}</body></html>`);

  if (p === '/overview' || p === '') return navPage('overview', overviewPage());
  if (p === '/chats') return navPage('chats', chatsPage());
  if (p === '/devices') return navPage('devices', devicesPage());
  if (p === '/training') return navPage('training', trainingPage());
  if (p === '/settings') return navPage('settings', settingsPage());
  if (p === '/logs') return navPage('logs', logsPage(url.searchParams.get('jid') || ''));

  html(res, 404, 'not found');
}

module.exports = { startServer };