const http = require('http');
const crypto = require('crypto');
const logger = require('./logger');
const { config } = require('./config');
const session = require('./session');
const store = require('./store');
const tts = require('./tts');
const bot = require('./bot');
const trainer = require('./trainer');
const learner = require('./learner');
const contacts = require('./contacts');

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

function readBodyBuffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 20e6) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function parseJsonBody(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: 'Invalid JSON body.' };
  }
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

// Log stream: merged command + voice logs, newest first.
function activityLogs(kind, limit) {
  const cmd = store.getCommandLogs('', limit).map((x) => ({ ...x, source: 'command' }));
  const voice = store.getVoiceLogs(limit).map((x) => ({
    ...x,
    source: 'voice',
    kind: x.direction === 'in' ? 'voice_in' : 'voice_out',
  }));
  let all = [...cmd, ...voice].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (kind) all = all.filter((x) => x.kind === kind);
  return all.slice(0, limit);
}

const KIND_LABELS = {
  reply: 'reply',
  send: 'sent',
  voice_command: 'voice-cmd',
  voice_in: 'voice in',
  voice_out: 'voice out',
  status_view: 'status',
  reaction: 'react',
  chat_command: 'cmd',
  fact: 'learned',
  memory: 'remembered',
};

/* ----------------------------- UI shell ----------------------------- */

const CSS = `:root{--bg:#05070d;--bg2:#0a0f1a;--card:#0c1420;--inset:#050810;--line:#1a2433;--line2:#263349;--tx:#e8eef7;--mut:#7e8ca6;--mut2:#54637e;--acc:#38bdf8;--acc2:#818cf8;--ok:#34d399;--bad:#f87171;--warn:#fbbf24;--mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter','Segoe UI',system-ui,-apple-system,sans-serif;background:
 radial-gradient(1100px 500px at 15% -10%,rgba(56,189,248,.06),transparent 60%),
 radial-gradient(900px 500px at 95% -10%,rgba(129,140,248,.07),transparent 60%),var(--bg);
 color:var(--tx);min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:var(--acc);text-decoration:none}
::selection{background:rgba(56,189,248,.28)}
button,input,select,textarea{font:inherit;padding:9px 13px;border-radius:10px;border:1px solid var(--line2);background:var(--bg2);color:var(--tx);outline:none}
button{cursor:pointer;transition:border-color .15s,background .15s,filter .15s}
button:hover{border-color:var(--acc)}
button:disabled{opacity:.45;cursor:not-allowed}
input:focus,select:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(56,189,248,.14)}
button.primary{background:linear-gradient(180deg,var(--acc),#0ea5e9);border-color:transparent;color:#05131f;font-weight:600}
button.primary:hover{filter:brightness(1.08)}
button.ghost{background:transparent;border-color:var(--line2)}
button.clear{border-color:rgba(248,113,113,.45);color:var(--bad)}
button.link{background:none;border:none;color:var(--acc);padding:2px 4px;font-size:12px}
button.link:hover{text-decoration:underline}
/* top bar */
.top{display:flex;align-items:center;gap:10px;padding:12px 22px;background:rgba(10,15,26,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
.logo{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#05131f;font-weight:800;font-size:15px}
.top h1{font-size:15px;margin:0;letter-spacing:.2px}
.top .sub{font-size:11px;color:var(--mut2);margin-top:1px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut);background:var(--bg2);white-space:nowrap}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--mut2)}
.pill.ok{color:var(--ok);border-color:rgba(52,211,153,.35)}
.pill.ok .dot{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.pill.bad{color:var(--bad);border-color:rgba(248,113,113,.35)}
.pill.bad .dot{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.pill.warn{color:var(--warn);border-color:rgba(251,191,36,.35)}
.pill.warn .dot{background:var(--warn)}
.spacer{flex:1}
/* nav */
nav{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--line);overflow-x:auto;background:rgba(10,15,26,.55)}
nav a{display:flex;align-items:center;gap:7px;color:var(--mut);font-size:13px;padding:12px 15px;border-bottom:2px solid transparent;white-space:nowrap}
nav a:hover{color:var(--tx)}
nav a.active{color:var(--tx);border-bottom-color:var(--acc)}
nav a .ic{opacity:.7;font-size:12px}
main{padding:18px 22px 70px;max-width:1280px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.card .lab{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--mut)}
.card h3{font-size:15px;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.card .v{font-size:25px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums}
.card .sub{font-size:11px;color:var(--mut);margin-top:3px}
.cols{display:grid;grid-template-columns:1fr 330px;gap:16px;align-items:start;margin-top:14px}
.equal .card{min-height:100%}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
thead th{text-align:left;padding:10px 12px;font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--mut);border-bottom:1px solid var(--line)}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:hover{background:rgba(56,189,248,.04)}
.mut{color:var(--mut)}.mut2{color:var(--mut2)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.acc{color:var(--acc)}
.sm{font-size:12px;color:var(--mut);line-height:1.55}
.code{background:var(--inset);border:1px dashed var(--line2);border-radius:12px;padding:18px;text-align:center}
.code .big{font-size:30px;letter-spacing:8px;font-weight:800;color:var(--acc);font-family:var(--mono);margin:8px 0}
.err{color:var(--bad);font-size:13px;min-height:16px}
.banner{border:1px solid var(--warn);border-radius:12px;padding:12px 15px;margin:14px 0;background:rgba(251,191,36,.07);color:var(--tx);font-size:13px;line-height:1.5}
  .banner.ok{border-color:var(--ok);background:rgba(52,211,153,.08)}
  .banner .qr-wrap{display:inline-block;background:#fff;padding:8px;border-radius:12px}
  .banner .qr{width:190px;height:190px;display:block;border-radius:6px}
.row{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:7px 0}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px}
.kv:last-child{border-bottom:none}
.kv span{color:var(--mut)}
/* terminal */
.term{background:var(--inset);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-family:var(--mono);font-size:12px}
.term .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:#0a0f1a}
.term .dots{display:flex;gap:5px}
.term .dot{width:9px;height:9px;border-radius:50%}
.term .dot.r{background:var(--bad)}.term .dot.y{background:var(--warn)}.term .dot.g{background:var(--ok)}
.term .ttl{font-size:11px;color:var(--mut);letter-spacing:.4px}
.term .body{padding:10px 14px;min-height:220px;max-height:430px;overflow:auto}
.term .body.tall{max-height:620px}
.term .line{display:flex;gap:9px;padding:4px 0;border-bottom:1px dashed rgba(26,36,51,.6);align-items:baseline}
.term .line .t{min-width:118px;color:var(--mut2);white-space:nowrap}
.term .k{font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--line2);white-space:nowrap;align-self:baseline}
.term .k.ok{color:var(--ok);border-color:rgba(52,211,153,.4)}
.term .k.acc{color:var(--acc);border-color:rgba(56,189,248,.4)}
.term .k.warn{color:var(--warn);border-color:rgba(251,191,36,.4)}
.term .k.bad{color:var(--bad);border-color:rgba(248,113,113,.4)}
.term .k.mut{color:var(--mut);border-color:var(--line2)}
.term .k.dim{color:var(--mut2);border-color:var(--line)}
.term .rest{flex:1;display:flex;gap:8px;min-width:0;overflow:hidden}
.term .who{color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.term .msg{color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conn-box{padding:4px 0}
/* modal */
.ovl{position:fixed;inset:0;background:rgba(2,4,9,.72);display:none;align-items:center;justify-content:center;z-index:50;padding:16px;backdrop-filter:blur(3px)}
.ovl.show{display:flex}
.modal{background:var(--card);border:1px solid var(--line2);border-radius:16px;max-width:540px;width:100%;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.modal h3{margin:0 0 6px;font-size:16px}
.modal .field{display:flex;flex-direction:column;gap:6px;margin:14px 0}
.modal .field label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut)}
.cwrap{position:relative}
.cwrap .cmd{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;background:var(--bg2);border:1px solid var(--line2);border-radius:12px;display:none;max-height:240px;overflow:auto;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.cwrap .cmd button{display:flex;flex-direction:column;gap:2px;width:100%;background:none;border:none;border-bottom:1px solid var(--line);border-radius:0;align-items:flex-start}
.cwrap .cmd button b{font-size:13px}
.cwrap .cmd button span{font-size:11px;color:var(--mut2);font-family:var(--mono)}
.cwrap .cmd button:hover{background:rgba(56,189,248,.08)}
.wrap{display:flex;flex-direction:column;gap:12px}
.login-wrap{max-width:400px;margin:12vh auto;background:var(--card);border:1px solid var(--line2);border-radius:16px;padding:30px;box-shadow:0 24px 60px rgba(0,0,0,.4)}
.login-wrap .logo{width:42px;height:42px;font-size:20px;border-radius:12px;margin-bottom:14px}
.login-wrap h2{margin:0 0 4px}
.login-wrap form{display:flex;flex-direction:column;gap:12px}
a.pill{transition:border-color .15s}
a.pill:hover{border-color:var(--acc)}
@media(max-width:700px){.main{padding:12px}.cols{grid-template-columns:1fr}.term .line .rest{flex-direction:column}.term .line{gap:6px}}`;

function navLinks() {
  return [
    ['overview', '▤', 'Overview'],
    ['chats', '▦', 'Chats'],
    ['logs', '◫', 'Logs'],
    ['devices', '◈', 'Devices & Logins'],
    ['training', '◉', 'Training'],
    ['settings', '⚙', 'Settings'],
  ];
}

function sendModal() {
  return `<div class="ovl" id="sendOvl"><div class="modal">
<h3>✉ Send a message</h3>
<p class="sm">Recipient can be a saved contact, a phone number (drop the leading + or 0), or a full WhatsApp JID.</p>
<div class="field"><label>To</label>
  <div class="cwrap">
    <input id="to" placeholder="e.g. Mama · 254712345678 · …" autocomplete="off">
    <div class="cmd" id="cList"></div>
  </div>
</div>
<div class="field"><label>Message</label>
  <textarea id="msg" rows="4" placeholder="Type the message to send, then hit Send →"></textarea>
</div>
<div class="row"><button class="primary" id="sendBtn" onclick="doSend()">Send →</button><span class="sm" id="sendStatus"></span></div>
<div class="err" id="err"></div>
</div></div>`;
}

function modalRelink() {
  return `<div class="ovl" id="relinkOvl"><div class="modal">
<h3>↻ Re-link WhatsApp</h3>
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
  const links = navLinks();
  const nav = '<nav>' + links.map(([k, ic, t]) =>
    `<a href="/${k}" class="${k === navActive ? 'active' : ''}"><span class="ic">${ic}</span>${t}</a>`).join('') + '</nav>';
  return `<header class="top">
<div class="logo">⚡</div>
<div><h1>${esc(config.name)}</h1><div class="sub">WhatsApp admin console</div></div>
<span class="pill" id="conn"><span class="dot"></span>…</span><span class="pill" id="num">…</span><span class="pill" id="clock">—</span>
<div class="spacer"></div>
<button class="primary" onclick="openSend()">✉ Send message</button>
<button class="ghost" id="relinkBtn">↻ Re-link</button>
</header>
${nav}
<script>
const $=q=>document.getElementById(q);
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function qs(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function j(u,o){const r=await fetch(u,o);return r.json();}
function fmt(ts){return new Date(ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function cnum(n){return n==null?'—':n;}
function refreshState(){fetch('/api/state').then(r=>r.json()).then(s=>{
  const c=$('conn'),n=$('num');
  c.className='pill '+(s.connected?'ok':(s.relinkPending?'warn':'bad'));
  c.innerHTML='<span class="dot"></span>'+(s.connected?'connected':(s.relinkPending?'linking…':s.connection));
  n.textContent=s.number||(s.pairingCode?('code '+s.pairingCode):'not linked');
}).catch(()=>{});}
let contactsAll=[];
function openSend(preJid,preName){
  const to=$('to'); 
  if(to){to.value=preJid&&preJid.indexOf('@')>-1?(preName||preJid):(preJid||'');to.dataset.jid=preJid||'';to.dataset.name=preName||preJid||'';}
  const msg=$('msg'); if(msg)msg.value='';
  const er=$('err'); if(er)er.textContent='';
  const st=$('sendStatus'); if(st)st.textContent='';
  $('sendOvl').classList.add('show');
  if(!contactsAll.length){
    fetch('/api/contacts').then(r=>r.json()).then(d=>{contactsAll=d.contacts||[];renderCList();}).catch(()=>{});
  } else renderCList();
  setTimeout(()=>{const i=$('to'); if(i)i.focus();},50);
}
function renderCList(){
  const i=$('to'), list=$('cList'); if(!i||!list)return;
  const q=i.value.trim().toLowerCase();
  const matches=contactsAll.filter(c=>(c.name||'').toLowerCase().includes(q)||c.jid.includes(q)).slice(0,8);
  list.innerHTML=matches.map(c=>'<button class="opt" onclick="pickContact(&quot;'+qs(c.jid)+'&quot;,&quot;'+qs(c.name||c.jid)+'&quot;)"><b>'+esc(c.name||c.jid)+'</b><span>'+esc(c.jid)+'</span></button>').join('');
  list.style.display=matches.length?'block':'none';
}
function pickContact(jid,name){const i=$('to');i.value=name||jid;i.dataset.jid=jid;i.dataset.name=name||jid;$('cList').style.display='none';}
async function doSend(){
  const i=$('to'),m=$('msg'),er=$('err'),st=$('sendStatus'),b=$('sendBtn');
  const to=i.dataset&&i.dataset.jid?i.dataset.jid:(i.value||'').trim(),msg=(m.value||'').trim();
  if(er)er.textContent='';
  if(!to||!msg){if(er)er.textContent='Recipient and message are required.';return;}
  st.textContent='Sending…';if(b)b.disabled=true;
  try{
    const r=await j('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to,message:msg})});
    if(r.ok){
      st.innerHTML='Delivered ✓ to <b>'+esc(r.name)+'</b>';
      if(i)i.value='';if(m)m.value='';i.dataset.jid='';i.dataset.name='';
      setTimeout(()=>{if(st)st.textContent='';$('sendOvl').classList.remove('show');},1400);
    } else {if(er)er.textContent=r.error||'Send failed';}
  }catch(e){if(er)er.textContent='Error: '+e.message;}
  if(b)b.disabled=false;
}
window.addEventListener('DOMContentLoaded',()=>{
  const ov=$('sendOvl'); if(ov)ov.onclick=e=>{if(e.target===ov)ov.classList.remove('show');};
  const to=$('to'); if(to)to.addEventListener('input',renderCList);
  const msg=$('msg'); if(msg)msg.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')doSend();});
});
// re-link
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
${modalRelink()}${sendModal()}`;
}

/* ----------------------------- pages ----------------------------- */

function loginPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${esc(config.name)}</title><style>${CSS}</style></head><body>
<div class="login-wrap">
<div class="logo">⚡</div>
<h2>${esc(config.name)}</h2>
<p class="mut" style="margin-top:-2px">Admin console — manage the WhatsApp bot, stream its logs and send messages.</p>
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
<div class="cols">
<div class="card">
  <div class="row" style="justify-content:space-between"><div class="lab">Live console</div><span class="pill" id="livePill"><span class="dot"></span>live</span></div>
  <div style="margin-top:12px"><div class="term">
  <div class="bar"><div class="dots"><div class="dot r"></div><div class="dot y"></div><div class="dot g"></div></div><div class="ttl">${esc(config.name)} · activity stream</div><div class="spacer"></div><span class="ttl" id="liveCnt"></span></div>
  <div class="body" id="termBody"><div class="mut">Waiting for activity…</div></div>
  </div></div>
</div>
<div class="card">
  <div class="lab">Connection</div>
  <div class="conn-box" id="connInfo"><div class="mut">Loading…</div></div>
  <div class="lab" style="margin-top:16px">Quick actions</div>
  <button class="primary" style="width:100%" onclick="openSend()">✉ Send a message</button>
  <button class="ghost" style="width:100%;margin-top:8px" onclick="relink()" id="relinkBtn">↻ Re-link WhatsApp</button>
  <button class="ghost" style="width:100%;margin-top:8px" onclick="location.href='/logs'">Open full logs</button>
</div>
</div>
<script>
fetch('/api/overview').then(r=>r.json()).then(o=>{
  document.getElementById('cards').innerHTML=[
   ['Messages today','total',''],['Replies sent','replies',''],['Active chats','activeChats',''],
   ['Voice notes','voiceCmdsCnt',''],['Statuses viewed','statuses',''],['Reactions','reactions',''],
   ['Contacts','contacts',''],['Uptime','minutes','min']]
   .map(([l,k,suf])=>'<div class="card"><div class="lab">'+l+'</div><div class="v">'+cnum(o[k])+'<span class="sub">'+suf+'</span></div></div>').join('');
});
function renderState(){
  fetch('/api/state').then(r=>r.json()).then(s=>{
    const b=document.getElementById('connBanner');
    if(s.connected){b.style.display='none';}
    else{
      b.style.display='block';
      if(s.relinkPending){
        b.innerHTML='<b>Re-linking…</b> watch for a new code or QR below.';
      } else if(s.pairingCode){
        b.innerHTML='<b>Pairing code.</b> In WhatsApp → Settings → Linked devices → "Link with phone number", enter: <b style="letter-spacing:3px">'+qs(s.pairingCode)+'</b>';
      } else if(s.qr){
        b.innerHTML='<b style="display:block">Scan this QR</b><span class="mut" style="display:block;margin:4px 0 10px">WhatsApp → Settings → Linked devices → "Link a device"</span>'+
          '<span class="qr-wrap"><img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=260x260&qzone=1&data='+encodeURIComponent(s.qr)+'" alt="QR"/></span>'+
          '<div class="mut" style="margin-top:10px">Tip: set <code>OWNER_PHONE</code> in <code>.env</code> (e.g. 254712345678) and Re-link to get an 8-character pairing code instead of scanning.</div>';
      } else {
        b.innerHTML='<b>'+ (s.connection==='connecting'?'Connecting to WhatsApp…':'Not connected.')+'</b><span class="mut" style="display:block;margin-top:4px">Click "↻ Re-link" below to generate a fresh QR / pairing code.</span>';
      }
      b.className='banner';
    }
    document.getElementById('connInfo').innerHTML=
      '<div class="kv"><span>State</span><b class="'+(s.connected?'ok':'bad')+'">'+esc(s.connection||'—')+'</b></div>'+
      '<div class="kv"><span>Number</span><b>'+esc(s.number||'—')+'</b></div>'+
      '<div class="kv"><span>Device</span><b>'+esc(s.device||'—')+'</b></div>'+
      '<div class="kv"><span>Contacts</span><b>'+cnum(s.contacts)+'</b></div>'+
      '<div class="kv"><span>Global pause</span><b class="'+(s.paused?'bad':'ok')+'">'+(s.paused?'ON':'off')+'</b></div>'+
      '<div class="kv"><span>Voice replies</span><b class="'+(s.voiceAuto?'ok':'mut')+'">'+(s.voiceAuto?'on':'off')+'</b></div>';
  }).catch(()=>{});
}
function renderLogs(){
  fetch('/api/logs?limit=60').then(r=>r.json()).then(d=>{
    const body=document.getElementById('termBody');
    body.innerHTML=d.logs.map(logHtml).join('')||'<div class="mut">No activity yet.</div>';
    document.getElementById('liveCnt').textContent=d.logs.length+' entries';
    body.scrollTop=0;
  }).catch(()=>{});
}
function logHtml(x){
  const L={reply:'ok',send:'acc',voice_command:'warn',voice_in:'dim',voice_out:'ok',status_view:'dim',reaction:'warn',chat_command:'dim',fact:'ok',memory:'ok'};
  const nm=esc(x.name||x.jid||'—');
  const body= x.source==='voice' ? (x.direction==='in'?'🎙 ':'🎧 ')+esc(x.transcript) : esc(x.detail);
  return '<div class="line"><span class="t">'+fmt(x.ts)+'</span><span class="k '+(L[x.kind]||'dim')+'">'+(x.kind||'log')+'</span><span class="rest"><b class="who">'+nm+'</b><span class="msg">'+body+'</span></span></div>';
}
function relink(){
  const b=document.getElementById('connBanner');
  if(b){b.style.display='block';b.innerHTML='<b>Re-linking…</b> watch for a fresh QR / pairing code below.';}
  const btn=document.getElementById('relinkBtn'); if(btn)btn.textContent='Re-linking…';
  fetch('/api/relink',{method:'POST'}).then(r=>r.json()).catch(()=>{})
    .then(()=>{setTimeout(renderState,4000);setTimeout(renderState,9000);setTimeout(renderFeedback,8000);})
    .catch(()=>{renderState();});
}
function renderFeedback(){const btn=document.getElementById('relinkBtn'); if(btn)btn.textContent='↻ Re-link WhatsApp';}
renderState();renderLogs();
setInterval(()=>{renderState();renderLogs();},5000);
</script>`)}</body></html>`;
}

function chatsPage() {
  return `<div class="card"><div class="row">
<input id="q" placeholder="Filter by name or number…" style="flex:1;min-width:180px">
<button onclick="load()">Filter</button>
<button class="primary" onclick="openSend()">✉ Send</button>
</div>
<table><thead><tr><th>Contact</th><th>JID</th><th>Auto</th><th>Muted</th><th>Mode</th><th>Last message</th><th>Today</th><th></th></tr></thead>
<tbody id="rows"></tbody></table></div>
<script>
function load(){
  fetch('/api/conversations').then(r=>r.json()).then(d=>{
    const q=(document.getElementById('q').value||'').toLowerCase();
    const rows=d.rows.filter(r=>!q||(r.name||'').toLowerCase().includes(q)||r.jid.includes(q));
    document.getElementById('rows').innerHTML=rows.map(r=>'<tr>'+
      '<td>'+esc(r.name||'—')+'</td><td class="mut">'+esc(r.jid)+'</td>'+
      '<td><button class="'+(r.auto_reply?'ok':'link')+'" onclick="auto(&quot;'+qs(r.jid)+'&quot;,'+(!r.auto_reply)+')">'+(r.auto_reply?'on':'off')+'</button></td>'+
      '<td><button class="'+(r.muted?'bad':'link')+'" onclick="mute(&quot;'+qs(r.jid)+'&quot;,'+(!r.muted)+')">'+(r.muted?'muted':'live')+'</button></td>'+
      '<td class="mut">'+(r.reply_mode=='voice'?'🎙':'text')+'</td>'+
      '<td class="mut">'+esc(String(r.last_text||'').slice(0,90))+'</td><td>'+(r.msgs_today||0)+'</td>'+
      '<td class="row" style="margin:0;justify-content:flex-end">'+
        '<button class="link" onclick="openSend(&quot;'+qs(r.jid)+'&quot;,&quot;'+qs(r.name||r.jid)+'&quot;)">✉ send</button>'+
        '<a href="/logs?jid='+encodeURIComponent(r.jid)+'">history</a></td></tr>').join('')||
      '<tr><td colspan=8 class="mut">No conversations yet.</td></tr>';
  });
}
function auto(j,v){fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jid:j,auto_reply:v})}).then(load);}
function mute(j,v){fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jid:j,muted:v})}).then(load);}
load();
setInterval(load,15000);
</script>`;
}

function devicesPage() {
  return `<div class="card">
<div class="row"><h3 style="margin:0;flex:1">Device & login audit</h3>
<button class="clear" onclick="clearLogins()">Clear log</button></div>
<p class="sm">The linked WhatsApp session and every admin dashboard login (IP + approx. location). WhatsApp does not expose GPS of linked devices.</p>
<table><thead><tr><th>Type</th><th>Number</th><th>Device</th><th>IP</th><th>Location</th><th>Detail</th><th>When</th></tr></thead>
<tbody id="rows"></tbody></table></div>
<script>
function fmt(ts){const d=new Date(ts);return d.toLocaleDateString()+' '+d.toLocaleTimeString();}
function load(){fetch('/api/logins').then(r=>r.json()).then(d=>{
  document.getElementById('rows').innerHTML=d.logins.map(x=>'<tr>'+
    '<td>'+(x.kind==='whatsapp'?'<span class="pill ok"><span class="dot"></span>WhatsApp</span>':'<span class="pill warn"><span class="dot"></span>Dashboard</span>')+'</td>'+
    '<td class="mut">'+esc(x.number||'—')+'</td><td>'+esc(x.device||'—')+'</td>'+
    '<td class="mut">'+esc(x.ip||'—')+'</td><td>'+esc(x.location||'—')+'</td>'+
    '<td class="mut">'+esc(x.detail||'')+'</td><td class="mut">'+fmt(x.ts)+'</td></tr>').join('')||'<tr><td colspan=7 class="mut">No logins recorded yet.</td></tr>';
});}
function clearLogins(){if(!confirm('Clear the whole login audit log?'))return;fetch('/api/logins/clear',{method:'POST'}).then(load);}
load();
</script>`;
}

function trainingPage() {
  return `<div class="cols">
<div class="card">
  <div class="lab">Teach the bot to sound like you</div>
  <p class="sm">Paste your own real WhatsApp messages below, or <b>upload a full chat export</b>. The bot learns your
  exact tone, slang and language-mixing and uses it as few-shot style for every reply.</p>
  <textarea id="txt" rows="4" style="width:100%" placeholder="e.g. niaje boss, ata kazi iko poa tu"></textarea>
  <div class="row"><button class="primary" onclick="addManual()">Add sample</button></div>
  <hr style="border-color:var(--line)">
  <div class="lab">Upload WhatsApp exports (.txt or .zip)</div>
  <p class="sm">WhatsApp → chat → More options → Export chat → without media. You can upload one <b>.txt</b> or a <b>.zip</b> of several. The bot learns your exact voice (including your emoji use) and applies it to ALL chats, plus remembers each person from those exports.</p>
  <div class="row"><input id="owner" placeholder="Your name or number in export (e.g. Chris)" style="flex:1">
  <input type="file" id="file" accept=".txt,.zip"></div>
  <div class="row"><button class="primary" onclick="upload()">Import chat</button><span class="sm" id="upStatus"></span></div>
</div>
<div class="card">
  <div class="row"><div class="lab" style="flex:1">Training samples used by the AI</div>
  <button class="clear" onclick="clearAll()">Clear all</button></div>
  <table><thead><tr><th>#</th><th>Sample</th><th>When</th><th></th></tr></thead>
  <tbody id="samp"></tbody></table>
</div></div>
<div class="cols">
<div class="card">
  <div class="row"><div class="lab" style="flex:1">Knowledge base — learned facts</div>
  <button class="clear" onclick="clearFacts()">Clear all</button></div>
  <p class="sm">Auto-extracted from the texts you send (or WhatsApp exports) and remembered across every reply. Kept even between restarts.</p>
  <table><thead><tr><th>Subject</th><th>Fact</th><th>Used</th><th></th></tr></thead>
  <tbody id="fbody"></tbody></table>
</div>
<div class="card">
  <div class="row"><div class="lab" style="flex:1">Conversation memory per chat</div>
  <button class="clear" onclick="clearSums()">Clear all</button></div>
  <p class="sm">Rolling summaries the bot builds for each chat so it can recall older context, not just the last few messages.</p>
  <table><thead><tr><th>Chat</th><th>Memory</th><th></th></tr></thead>
  <tbody id="sbody"></tbody></table>
</div></div>
<script>
function load(){fetch('/api/train').then(r=>r.json()).then(d=>{
  document.getElementById('samp').innerHTML=d.samples.map(s=>'<tr><td>'+(s.id)+'</td><td>'+esc(s.text)+'</td>'+
    '<td class="mut">'+new Date(s.ts).toLocaleString()+'</td><td><a href="javascript:del('+s.id+')">delete</a></td></tr>').join('')
    ||'<tr><td colspan=4 class="mut">No samples yet — the bot learns as you add or import.</td></tr>';
});}
function loadFacts(){fetch('/api/facts').then(r=>r.json()).then(d=>{
  document.getElementById('fbody').innerHTML=d.facts.map(f=>
    '<tr><td><b>'+esc(f.subject)+'</b></td><td>'+esc(f.fact)+'</td><td class="mut">×'+f.hits+'</td>'+
    '<td><a href="javascript:delFact('+f.id+')">delete</a></td></tr>').join('')||
    '<tr><td colspan=4 class="mut">No facts learned yet — send it texts like "Mama likes chai strong" and they will appear here.</td></tr>';
});}
function delFact(id){fetch('/api/facts/'+id,{method:'DELETE'}).then(loadFacts);}
function clearFacts(){if(!confirm('Delete ALL learned facts?'))return;fetch('/api/facts/clear',{method:'POST'}).then(loadFacts);}
function loadSum(){fetch('/api/summaries').then(r=>r.json()).then(d=>{
  document.getElementById('sbody').innerHTML=d.summaries.map(s=>
    '<tr><td>'+esc(s.name||s.jid)+'</td><td class="mut">'+esc(String(s.summary).slice(0,220))+'</td>'+
    '<td><a href="javascript:delSum(&quot;'+qs(s.jid)+'&quot;)">delete</a></td></tr>').join('')||
    '<tr><td colspan=3 class="mut">No conversation memory yet — it builds up automatically as the bot talks in chats.</td></tr>';
});}
function delSum(jid){fetch('/api/summaries?jid='+encodeURIComponent(jid),{method:'DELETE'}).then(loadSum);}
function clearSums(){if(!confirm('Delete ALL conversation memory?'))return;fetch('/api/summaries/clear',{method:'POST'}).then(loadSum);}
function addManual(){const t=document.getElementById('txt').value;if(!t.trim())return;
  fetch('/api/train',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})}).then(()=>{document.getElementById('txt').value='';load();});}
function upload(){
  const f=document.getElementById('file').files[0];
  if(!f)return;
  const owner=document.getElementById('owner').value.trim();
  document.getElementById('upStatus').textContent='Importing…';
  const isZip=/\.zip$/i.test(f.name);
  const prep = isZip ? f.arrayBuffer().then(b=>new Uint8Array(b)) : f.text();
  prep.then(data=>fetch('/api/train/upload',{method:'POST',
      headers:{'content-type':isZip?'application/zip':'text/plain','x-owner':owner,'x-filename':f.name},
      body:data}))
    .then(r=>r.json()).then(d=>{
      const parts=[];
      if(d.files) parts.push((d.files.length>1?d.files.length+' chats':'chat')+' → '+d.added+' style samples');
      else parts.push('matched '+d.matched+' → '+d.added+' style samples');
      if(d.facts) parts.push('learned '+d.facts+' fact'+(d.facts===1?'':'s'));
      if(d.memories) parts.push('remembered '+d.memories+' person'+(d.memories===1?'':'s'));
      document.getElementById('upStatus').textContent=(parts.join(', ')||'done')+'.';
      load(); loadFacts(); loadSum();
    }).catch(e=>document.getElementById('upStatus').textContent='Import failed: '+e.message);
}
function del(id){fetch('/api/train/'+id,{method:'DELETE'}).then(load);}
function clearAll(){if(!confirm('Delete ALL training samples?'))return;fetch('/api/train/clear',{method:'POST'}).then(load);}
load();loadFacts();loadSum();
</script>`;
}

function settingsPage() {
  return `<div class="cols">
<div class="card">
  <div class="lab">Behaviour</div>
  <div class="row"><b style="flex:1">Global pause (stop all replies)</b><button id="pause" class="ghost" onclick="toggle('global_pause')">…</button></div>
  <div class="row"><b style="flex:1">React/like statuses after viewing</b><button id="reacts" class="ghost" onclick="toggle('status_react')">…</button></div>
  <div class="row"><b style="flex:1">Reply to voice notes with voice</b><button id="voice" class="ghost" onclick="toggle('voice_auto')">…</button></div>
</div>
<div class="card">
  <div class="lab">AI & integrations</div>
  <table><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody id="keys"></tbody></table>
  <p class="sm">Provider: <b id="prov" class="acc">…</b> · TTS: <b id="tts" class="acc">…</b></p>
</div>
</div>
<div class="card" style="margin-top:16px">
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
    document.getElementById('reacts').className=c.statusReacts?'primary':'ghost';
    document.getElementById('voice').textContent=c.voiceAuto?'on':'off';
    document.getElementById('voice').className=c.voiceAuto?'primary':'ghost';
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
  if (jid) {
    const q = encodeURIComponent(jid).replace(/'/g, '%27').replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/~/g, '%7E');
    return `<div class="card"><div class="row"><h3 style="margin:0;flex:1">Chat history — <span class="mut">${esc(jid)}</span></h3>
<button class="primary" onclick="openSend(JID,JID)">✉ Send here</button>
<button class="ghost" onclick="location.href='/logs'">All logs</button></div>
<table><thead><tr><th>Role</th><th>Text</th><th>When</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
var JID='${esc(jid)}';
fetch('/api/history?jid=${q}').then(r=>r.json()).then(d=>{
  document.getElementById('rows').innerHTML=d.history.map(h=>'<tr><td>'+(h.role==='user'?'<span class="k ok" style="display:inline-flex;font-family:var(--mono);font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid rgba(52,211,153,.4);color:var(--ok)">in</span>':'<span class="k acc" style="display:inline-flex;font-family:var(--mono);font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid rgba(56,189,248,.4);color:var(--acc)">out</span>')+'</td>'+
    '<td>'+esc(h.text)+'</td><td class="mut">'+new Date(h.ts).toLocaleString()+'</td></tr>').join('')||'<tr><td colspan=3 class="mut">No history.</td></tr>';
});
</script>`;
  }
  return `<div class="card">
<div class="row">
  <h3 style="margin:0;flex:1">Activity log</h3>
  <div class="row" id="filters" style="margin:0"></div>
  <input id="q" placeholder="Search…" style="min-width:180px;width:200px">
</div>
<p class="sm">Every reply, sent message, voice command, voice note, status view and reaction the bot has logged. Live-updates every 5s.</p>
<div class="term"><div class="bar"><div class="dots"><div class="dot r"></div><div class="dot y"></div><div class="dot g"></div></div><div class="ttl">log stream</div><div class="spacer"></div><span class="pill" id="cnt">— entries</span></div>
<div class="body tall" id="termBody"><div class="mut">Loading…</div></div></div>
</div>
<script>
const KINDS={all:['all','ghost'],reply:['reply','ok'],send:['sent','acc'],voice_command:['voice-cmd','warn'],voice_in:['voice in','dim'],voice_out:['voice out','ok'],status_view:['status','dim'],reaction:['react','warn'],chat_command:['cmd','dim'],fact:['learned','ok'],memory:['remembered','ok']};
let curK='all';
function renderFilters(){const f=document.getElementById('filters');f.innerHTML=Object.entries(KINDS).map(([k])=>'<button class="'+(k===curK?'primary':'ghost')+'" onclick="setKind(&quot;'+k+'&quot;)">'+KINDS[k][0]+'</button>').join('');}
function setKind(k){curK=k;renderFilters();load();}
function logHtml(x){
  const cls=(x.kind==='send'?'acc':(x.kind==='voice_in'||x.kind==='status_view'||x.kind==='chat_command')?'dim':(x.kind==='voice_out'||x.kind==='reply'||x.kind==='fact'||x.kind==='memory')?'ok':'warn');
  const nm=esc(x.name||x.jid||'—');
  const body= x.source==='voice' ? (x.direction==='in'?'🎙 voice note · ':'🎧 voice reply · ')+esc(x.transcript) : esc(x.detail);
  return '<div class="line"><span class="t">'+fmt(x.ts)+'</span><span class="k '+cls+'">'+(x.kind||'log')+'</span><span class="rest"><b class="who">'+nm+'</b><span class="msg">'+body+'</span></span></div>';
}
function load(){
  const q=(document.getElementById('q').value||'').toLowerCase();
  fetch('/api/logs?limit=400&kind='+curK).then(r=>r.json()).then(d=>{
    const rows=d.logs.filter(x=>!q||((x.name||'')+(x.jid||'')+(x.source==='voice'?x.transcript:x.detail)).toLowerCase().includes(q));
    document.getElementById('cnt').textContent=rows.length+' entries';
    document.getElementById('termBody').innerHTML=rows.map(logHtml).join('')||'<div class="mut">No entries.</div>';
  }).catch(()=>{});
}
document.getElementById('q').addEventListener('input',load);
renderFilters();load();
setInterval(load,5000);
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

function resolveRecipient(to) {
  let t = String(to || '').trim();
  t = t.replace(/^https?:\/\/wa\.me\//, '').trim();
  if (!t) return { error: 'Recipient is empty.' };

  const digits = t.replace(/[\s+\-()]/g, '');
  if (/^\d{9,15}$/.test(digits)) {
    const intl = digits.startsWith('0') ? '254' + digits.slice(1) : digits;
    return { jid: intl + '@s.whatsapp.net', name: intl };
  }
  if (t.includes('@')) return { jid: t, name: t.split('@')[0] };

  const scored = contacts.search(t);
  if (!scored.length) {
    return { error: `Couldn't find "${to}" in contacts. Use a saved name, a phone number (e.g. 254712345678) or a WhatsApp JID.` };
  }
  return { jid: scored[0].jid, name: scored[0].name };
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

  if (m === 'GET' && (p === '/health' || p.startsWith('/health'))) {
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
    const parsed = parseJsonBody(await readBody(req));
    if (!parsed.ok) { json(res, 400, { ok: false, error: parsed.error }); return; }
    const b = parsed.value;
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

    // Send a message from the dashboard ("text a person")
    if (m === 'POST' && p === '/api/send') {
      let b = {};
      try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) { json(res, 400, { ok: false, error: 'Invalid JSON body.' }); return; }
      const to = String(b.to || '').trim();
      const message = String(b.message || '').trim();
      if (!to || !message) { json(res, 400, { ok: false, error: 'Recipient and message are required.' }); return; }
      if (message.length > 2000) { json(res, 400, { ok: false, error: 'Message is too long (max 2000 chars).' }); return; }

      const target = resolveRecipient(to);
      if (target.error) { json(res, 400, { ok: false, error: target.error }); return; }

      const sock = session.getSocket();
      if (!sock || !session.getState().connected) {
        json(res, 400, { ok: false, error: 'WhatsApp is not connected. Re-link the device first.' });
        return;
      }

      try {
        await sock.sendMessage(target.jid, { text: message });
        store.setLastSent(target.jid, Date.now());
        store.addHistory(target.jid, 'assistant', message);
        store.addCommandLog(target.jid, 'send', `${target.name} (${target.jid}): ${message.slice(0, 200)}`);
        logger.info(`dashboard send → ${target.name} (${target.jid}): ${message.slice(0, 80)}`);
        json(res, 200, { ok: true, jid: target.jid, name: target.name });
      } catch (e) {
        store.addCommandLog(target.jid || 'dashboard', 'send', `FAILED ${target.name}: ${String(e.message).slice(0, 200)}`);
        logger.error(`dashboard send failed → ${target.name}:`, e.message);
        json(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // Unified activity log (command + voice), newest first
    if (m === 'GET' && p === '/api/logs') {
      const kind = url.searchParams.get('kind') || '';
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
      json(res, 200, { logs: activityLogs(kind, limit) });
      return;
    }

    // Knowledge base
    if (m === 'GET' && p === '/api/facts') { json(res, 200, { facts: store.getFacts(200) }); return; }
    if (m === 'DELETE' && /^\/api\/facts\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      try { store.deleteFact(id); json(res, 200, { ok: true }); }
      catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return;
    }
    if (m === 'POST' && p === '/api/facts/clear') { store.clearFacts(); json(res, 200, { ok: true }); return; }

    // Rolling conversation memory
    if (m === 'GET' && p === '/api/summaries') { json(res, 200, { summaries: store.getSummaries(200) }); return; }
    if (m === 'DELETE' && p === '/api/summaries') {
      const jid = url.searchParams.get('jid') || '';
      store.deleteSummary(jid);
      json(res, 200, { ok: true });
      return;
    }
    if (m === 'POST' && p === '/api/summaries/clear') { store.clearSummaries(); json(res, 200, { ok: true }); return; }

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
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) { json(res, 400, { ok: false, error: parsed.error }); return; }
      const b = parsed.value;
      if (b.text && String(b.text).trim()) {
        trainer.addManual(b.text);
        json(res, 200, { ok: true });
      } else json(res, 400, { ok: false, error: 'text required' });
      return;
    }
    if (m === 'POST' && p === '/api/train/upload') {
      const raw = await readBodyBuffer(req);
      const owner = req.headers['x-owner'] || config.ownerPhone || '';
      const fileName = req.headers['x-filename'] || '';
      const isZip = /zip/i.test(req.headers['content-type'] || '') || /\.zip$/i.test(fileName);
      const report = { files: [], sourced: 0, added: 0, matched: 0, skipped: 0, facts: 0, memories: 0, errors: 0 };
      const batches = [];

      try {
        const texts = isZip
          ? trainer.readZipTextFiles(raw)
          : [{ name: fileName || 'chat.txt', text: raw.toString('utf8') }];
        if (isZip && !texts.length) throw new Error('no .txt chat files found in the zip');
        for (const t of texts) {
          const parsed = trainer.parseWhatsAppExport(t.text, owner);
          for (const s of parsed.texts) store.addStyleSample('training', s);
          report.files.push({ file: t.name, matched: parsed.matched, skipped: parsed.skipped, added: parsed.texts.length });
          report.sourced += 1;
          report.matched += parsed.matched;
          report.skipped += parsed.skipped;
          report.added += parsed.texts.length;
          batches.push({ ownerName: owner, otherLabels: parsed.otherLabels, msgs: parsed.msgs });
        }
      } catch (e) {
        report.errors = 1;
        json(res, 400, { ok: false, error: e.message });
        return;
      }

      for (const b of batches) {
        try {
          const r = await learner.learnConversation(b);
          report.facts += r.facts;
          report.memories += r.memories;
        } catch (e) {
          logger.warn('import learning skipped:', e.message || e);
        }
      }

      json(res, 200, { ok: true, ...report });
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
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) { json(res, 400, { ok: false, error: parsed.error }); return; }
      const b = parsed.value;
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

  if (p === '/' || p === '/overview' || p === '') return navPage('overview', overviewPage());
  if (p === '/chats') return navPage('chats', chatsPage());
  if (p === '/logs') return navPage('logs', logsPage(url.searchParams.get('jid') || ''));
  if (p === '/devices') return navPage('devices', devicesPage());
  if (p === '/training') return navPage('training', trainingPage());
  if (p === '/settings') return navPage('settings', settingsPage());

  html(res, 404, 'not found');
}

module.exports = { startServer };