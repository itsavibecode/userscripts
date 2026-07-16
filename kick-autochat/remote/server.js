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
const REMOTE_VERSION = '1.0.0';

const PORT = Number(process.env.PORT || 3300);
const HTML = path.join(__dirname, 'remote.html');

let lastState = null;   // most recent snapshot from the userscript
let lastStateAt = 0;    // when it arrived, so we can tell if the PC went away
let commands = [];      // queued commands waiting for the userscript to collect

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
    if (d.cmd) commands.push(String(d.cmd));
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
