// Kick Auto-Chat — local remote-control broker.
//
//   node server.js            (optionally: PORT=3300 node server.js)
//
// The userscript (running on https://kick.com) POSTs its state to
// http://127.0.0.1:PORT/sync every couple of seconds and picks up any queued
// commands in the response. Your phone loads this same server over the LAN and
// pushes commands to /cmd. The server is just a mailbox between the two — it
// holds no logic and nothing is persisted.
//
// Why localhost for the userscript: kick.com is HTTPS, and browsers block
// requests from an HTTPS page to plain http:// — EXCEPT to localhost/127.0.0.1,
// which is treated as a trustworthy origin. The phone has no such problem
// because the page it loads is itself http://.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Version of the remote (this server + remote.html). Tracked separately from the
// userscript, which ships and updates on its own. Declared here and injected
// into the page at serve time so there's one source of truth.
const REMOTE_VERSION = '1.4.1';

const PORT = Number(process.env.PORT || 3300);
const HTML = path.join(__dirname, 'remote.html');

// $CHAT (Chat Hype Index) 24h-low monitor. The shoovy.wtf stocks API sends NO
// Access-Control-Allow-Origin header, so the kick.com userscript CANNOT fetch it
// from the browser (CORS). Node has no such restriction, so the SERVER polls it
// and pushes a {chatLow:{…}} command to the userscript via the normal /sync
// command channel. Only polls while a connected userscript reports chatMonitor.
const CHAT_API = 'https://shoovy.wtf/api/stocks';
const CHAT_SYMBOL = 'CHAT';
const CHAT_POLL_MS = 30000;            // how often to hit the API while monitoring
const CHAT_ALERT_COOLDOWN_MS = 45000;  // min gap between two low alerts
const CHAT_MAX_BACKOFF_MS = 5 * 60 * 1000; // cap the backoff while the API misbehaves
// A browser-ish User-Agent. The API sometimes answers a headless request with a
// Cloudflare/bot-challenge HTML page instead of JSON (more likely via a VPN exit);
// a normal UA reduces that. We also handle the HTML case gracefully below.
const CHAT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let lastState = null;   // most recent snapshot from the userscript
let lastStateAt = 0;    // when it arrived, so we can tell if the PC went away
let commands = [];      // queued commands waiting for the userscript to collect

// $CHAT poll state.
let chatLastLow = null; // last day_low we've seen (null = need to re-baseline)
let chatPollAt = 0;     // epoch ms of the last API poll (rate-limits polling)
let chatAlertAt = 0;    // epoch ms of the last alert we pushed (cooldown)
let chatFailCount = 0;  // consecutive poll failures — drives backoff + quiet logging

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Chrome's Private Network Access check: an HTTPS page reaching 127.0.0.1
  // needs this on the preflight or the request is refused.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1e6) req.destroy(); // don't let a bad client eat memory
    });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = (req.url || '/').split('?')[0];

  // Userscript heartbeat: push state, pull queued commands.
  if (url === '/sync' && req.method === 'POST') {
    const d = await readBody(req);
    if (d.state) { lastState = d.state; lastStateAt = Date.now(); }
    const out = commands;
    commands = [];
    return json(res, 200, { commands: out });
  }

  // Phone: read the current state.
  if (url === '/state' && req.method === 'GET') {
    const age = Date.now() - lastStateAt;
    return json(res, 200, {
      connected: !!lastState && age < 8000,
      ageMs: lastState ? age : null,
      state: lastState,
    });
  }

  // Phone: queue a command for the userscript.
  if (url === '/cmd' && req.method === 'POST') {
    const d = await readBody(req);
    // Accept a plain string ('start') OR an object ({set:{message:'…'}}). Do NOT
    // stringify: an object command must survive intact to the userscript, which
    // routes it through applyRemoteCommand. The broker holds no opinion on shape.
    if (d.cmd !== undefined && d.cmd !== null) commands.push(d.cmd);
    return json(res, 200, { ok: true, queued: commands.length });
  }

  if (url === '/' || url === '/index.html') {
    return fs.readFile(HTML, 'utf8', (err, text) => {
      if (err) { res.writeHead(500); return res.end('remote.html is missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(text.replace(/\{\{REMOTE_VERSION\}\}/g, REMOTE_VERSION));
    });
  }

  // Home-screen icons and the web app manifest. An explicit allowlist rather
  // than mapping the URL onto the filesystem, so no path can escape this folder.
  const STATIC = {
    '/icon-32.png': 'image/png',
    '/icon-180.png': 'image/png',
    '/icon-192.png': 'image/png',
    '/icon-512.png': 'image/png',
    '/manifest.webmanifest': 'application/manifest+json',
    '/favicon.ico': 'image/png', // browsers ask for this unprompted
  };
  if (STATIC[url]) {
    const file = path.join(__dirname, url === '/favicon.ico' ? 'icon-32.png' : url);
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': STATIC[url], 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    });
  }

  res.writeHead(404);
  res.end('not found');
});

// Without this, a second copy dies with an unhandled 'error' event and a wall of
// stack trace. The overwhelmingly likely cause is simply that it's already up.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} is already in use.`);
    console.error('');
    console.error('  The remote server is almost certainly ALREADY RUNNING in another');
    console.error('  window - look for it, or just open the phone address again.');
    console.error('');
    console.error('  If you want a second one on a different port:');
    console.error(`      set PORT=3301 && node server.js`);
    console.error('  then set that same port in the Kick panel (gear - Server port).');
  } else {
    console.error('');
    console.error('  Server error:', (err && err.message) || err);
  }
  console.error('');
  process.exit(1);
});

// Pure decision so the alert logic is testable in isolation. Given the previous
// tracked low, the freshly fetched low, when we last alerted, and now, decide
// whether to alert and what low to store. Alert ONLY on a strict decrease, and
// only if the cooldown has elapsed; a null prevLow is the first-sight baseline
// (store it, never alert); equal or higher just tracks the rolling low.
function decideChatAlert(prevLow, low, lastAlertAt, now) {
  if (prevLow === null || prevLow === undefined) {
    return { alert: false, newLow: low }; // baseline — no alert
  }
  if (low < prevLow) {
    return { alert: (now - lastAlertAt) >= CHAT_ALERT_COOLDOWN_MS, newLow: low };
  }
  return { alert: false, newLow: low };   // equal/higher — track, don't alert
}

// Poll shoovy.wtf for a new $CHAT 24h low and queue an alert if one appears.
// We poll here (not in the browser) because the API has no CORS header, so a
// kick.com page can't read it. Only runs while a connected userscript reports
// chatMonitor === true; otherwise it re-baselines so a resumed watch is clean.
// While the API is failing, poll less and less often (30s → 1m → 2m → … capped
// at 5m) so we don't hammer a challenging endpoint or flood the console.
function chatPollInterval() {
  if (chatFailCount === 0) return CHAT_POLL_MS;
  return Math.min(CHAT_POLL_MS * Math.pow(2, Math.min(chatFailCount, 4)), CHAT_MAX_BACKOFF_MS);
}

async function maybePollChat() {
  const shouldPoll = lastState && (Date.now() - lastStateAt < 8000) && lastState.chatMonitor === true;
  if (!shouldPoll) {
    chatLastLow = null; // re-baseline cleanly next time monitoring resumes
    return;
  }
  const now = Date.now();
  if (now - chatPollAt < chatPollInterval()) return;
  chatPollAt = now;
  try {
    const r = await fetch(CHAT_API, { headers: { 'User-Agent': CHAT_UA, 'Accept': 'application/json' } });
    const ct = r.headers.get('content-type') || '';
    // The bot-challenge page comes back as HTML with a 200 — check the type, don't
    // just hand whatever it is to JSON.parse and let it throw a wall of noise.
    if (!r.ok || !ct.includes('json')) {
      throw new Error(`non-JSON response (HTTP ${r.status}${ct ? ', ' + ct.split(';')[0] : ''}) — likely a Cloudflare/bot challenge`);
    }
    const data = await r.json();
    const q = data && Array.isArray(data.quotes)
      ? data.quotes.find((x) => x && x.symbol === CHAT_SYMBOL) : null;
    if (!q || !Number.isFinite(q.day_low)) throw new Error('CHAT quote / day_low missing from response');
    const low = q.day_low;
    const d = decideChatAlert(chatLastLow, low, chatAlertAt, now);
    if (d.alert) {
      // Object command passes through /sync intact to applyRemoteCommand.
      commands.push({ chatLow: { low, prev: chatLastLow, price: q.price, change_pct: q.change_pct } });
      chatAlertAt = now;
    }
    chatLastLow = d.newLow;
    if (chatFailCount > 0) { console.log('$CHAT poll recovered — reading prices again.'); chatFailCount = 0; }
  } catch (e) {
    chatFailCount++;
    // Log only the FIRST failure of a streak, then go quiet (and back off), so a
    // persistent challenge doesn't scroll the window forever. Recovery re-announces.
    if (chatFailCount === 1) {
      console.error('$CHAT poll failed:', (e && e.message) || e);
      console.error('  Backing off and retrying quietly; you will see one line when it recovers.');
    }
  }
}

// ~10s tick; maybePollChat rate-limits the actual API hit to CHAT_POLL_MS. The
// extra .catch is belt-and-suspenders so a rejection can never crash the server.
setInterval(() => { maybePollChat().catch((e) => console.error('$CHAT poll error:', (e && e.message) || e)); }, 10000);

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log(`Kick Auto-Chat remote v${REMOTE_VERSION} — listening on port ${PORT}`);
  console.log(`  userscript connects to : http://127.0.0.1:${PORT}`);
  if (ips.length) {
    for (const ip of ips) console.log(`  open on your phone     : http://${ip}:${PORT}`);
  } else {
    console.log('  (no LAN address found — is this machine on a network?)');
  }
  console.log('\nAnyone on your network who opens that address can control the bot.');
  console.log('Stop the server with Ctrl+C when you are done.');
});
