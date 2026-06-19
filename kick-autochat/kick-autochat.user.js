// ==UserScript==
// @name         Kick Auto-Chat (iceposeidon)
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.1.0
// @description  Auto-send a message to a Kick.com chat on a timer without needing window focus. Draggable GUI to change the message, interval, and cooldown.
// @author       itsavibecode
// @match        https://kick.com/iceposeidon*
// @match        https://kick.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/kick-autochat
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-autochat/kick-autochat.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-autochat/kick-autochat.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ----------------------------------------------------------------------
  // Persistent settings (localStorage, per-origin)
  // ----------------------------------------------------------------------
  const STORE_KEY = 'kick-autochat:settings';
  const DEFAULTS = {
    message: 'Cx',
    intervalSec: 65,   // base time between sends
    cooldownSec: 65,   // minimum gap that MUST pass since last successful send
    antiDup: true,     // append a varying zero-width char so Kick won't reject duplicates
    running: false,
    collapsed: false,
    pos: { left: null, top: null },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch (e) { /* ignore quota errors */ }
  }

  const settings = loadSettings();

  // ----------------------------------------------------------------------
  // Runtime state
  // ----------------------------------------------------------------------
  let tickTimer = null;       // 1s UI/scheduler tick
  let nextSendAt = 0;         // epoch ms of the next scheduled send
  let lastSendAt = 0;         // epoch ms of the last successful send
  let sendCount = 0;
  let dupCounter = 0;         // drives the anti-duplicate varying suffix

  // ----------------------------------------------------------------------
  // Chat input / send logic
  // ----------------------------------------------------------------------

  // Kick has gone through a few editor implementations. Try the most likely
  // selectors for the chat message box, newest first.
  const INPUT_SELECTORS = [
    'div[data-input="true"]',
    '#message-input',
    'div[contenteditable="true"][role="textbox"]',
    'div.editor-input[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea[name="message"]',
    'textarea',
  ];

  const SEND_BTN_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[type="submit"]',
  ];

  function findInput() {
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function findSendButton() {
    for (const sel of SEND_BTN_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && !el.disabled) return el;
    }
    return null;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function buildMessage() {
    let msg = settings.message;
    if (settings.antiDup) {
      // Append N invisible zero-width spaces so Kick doesn't see an identical
      // consecutive message. Cycles 0..5 so it never grows unbounded.
      dupCounter = (dupCounter + 1) % 6;
      msg += '​'.repeat(dupCounter);
    }
    return msg;
  }

  // Insert text into a contenteditable (Lexical/ProseMirror friendly) or a
  // textarea, then submit. Returns true if a send was attempted.
  function sendMessage() {
    const input = findInput();
    if (!input) {
      log('Chat input not found — is chat loaded / are you logged in?', true);
      return false;
    }

    const text = buildMessage();
    const isTextarea = input.tagName === 'TEXTAREA';

    input.focus();

    if (isTextarea) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable: clear then insert via execCommand so the editor's
      // beforeinput/input handlers (Lexical) pick it up.
      selectAll(input);
      try {
        document.execCommand('insertText', false, text);
      } catch (e) {
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
    }

    // Submit: prefer the send button; fall back to dispatching Enter.
    const btn = findSendButton();
    if (btn) {
      btn.click();
    } else {
      dispatchEnter(input);
    }

    sendCount++;
    lastSendAt = Date.now();
    log(`Sent #${sendCount}: "${settings.message}"`);
    updateStatus();
    return true;
  }

  function selectAll(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function dispatchEnter(el) {
    const opts = {
      bubbles: true, cancelable: true,
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ----------------------------------------------------------------------
  // Scheduler  (1s tick so the UI countdown stays live and timing is exact)
  // ----------------------------------------------------------------------
  function scheduleNext() {
    const now = Date.now();
    // Next send respects BOTH the interval and the minimum cooldown gap.
    const byInterval = now + settings.intervalSec * 1000;
    const byCooldown = lastSendAt + settings.cooldownSec * 1000;
    nextSendAt = Math.max(byInterval, byCooldown);
  }

  function tick() {
    if (!settings.running) return;
    const now = Date.now();
    if (now >= nextSendAt) {
      sendMessage();
      scheduleNext();
    }
    updateStatus();
  }

  function start() {
    if (settings.running) return;
    settings.running = true;
    saveSettings();
    // First send fires after a full interval (set to 0 below to fire immediately
    // if you prefer). We honor cooldown from the last send too.
    scheduleNext();
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
    log('Started.');
    syncControls();
    updateStatus();
  }

  function stop() {
    settings.running = false;
    saveSettings();
    log('Stopped.');
    syncControls();
    updateStatus();
  }

  function sendNow() {
    sendMessage();
    if (settings.running) scheduleNext();
    updateStatus();
  }

  // ----------------------------------------------------------------------
  // GUI
  // ----------------------------------------------------------------------
  let ui = {};

  function injectStyles() {
    const css = `
      #kac-panel{position:fixed;z-index:2147483647;top:90px;right:16px;width:248px;
        background:#0f0f12;color:#e7e7ea;font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;
        border:1px solid #2a2a30;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);
        user-select:none;overflow:hidden}
      #kac-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;
        background:linear-gradient(90deg,#1b2f1b,#13131a);border-bottom:1px solid #2a2a30}
      #kac-head .dot{width:8px;height:8px;border-radius:50%;background:#666;flex:0 0 auto}
      #kac-head .dot.on{background:#53fc18;box-shadow:0 0 8px #53fc18}
      #kac-title{font-weight:700;letter-spacing:.3px;flex:1}
      #kac-collapse{cursor:pointer;background:none;border:none;color:#9a9aa3;font-size:14px;padding:0 2px}
      #kac-body{padding:10px;display:flex;flex-direction:column;gap:8px}
      #kac-body.hidden{display:none}
      .kac-row{display:flex;flex-direction:column;gap:3px}
      .kac-row label{color:#9a9aa3;font-size:11px}
      .kac-row input[type=text],.kac-row input[type=number]{background:#17171c;border:1px solid #2a2a30;
        color:#e7e7ea;border-radius:6px;padding:6px 8px;font:inherit;width:100%;box-sizing:border-box}
      .kac-grid{display:flex;gap:8px}
      .kac-grid .kac-row{flex:1}
      .kac-check{display:flex;align-items:center;gap:6px;color:#cfcfd6;cursor:pointer}
      .kac-btns{display:flex;gap:8px;margin-top:2px}
      .kac-btn{flex:1;border:none;border-radius:7px;padding:8px;font:inherit;font-weight:700;cursor:pointer}
      #kac-toggle.start{background:#53fc18;color:#0a0a0a}
      #kac-toggle.stop{background:#ff4757;color:#fff}
      #kac-now{background:#2a2a30;color:#e7e7ea}
      #kac-status{font-size:11px;color:#9a9aa3;min-height:14px}
      #kac-status b{color:#53fc18}
      #kac-log{font-size:10.5px;color:#7d7d85;background:#0a0a0d;border:1px solid #1d1d22;
        border-radius:6px;padding:6px;height:64px;overflow:auto;white-space:pre-wrap}
      #kac-log .err{color:#ff7b7b}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'kac-panel';
    p.innerHTML = `
      <div id="kac-head">
        <span class="dot" id="kac-dot"></span>
        <span id="kac-title">Kick Auto-Chat</span>
        <button id="kac-collapse" title="Collapse">_</button>
      </div>
      <div id="kac-body">
        <div class="kac-row">
          <label>Message</label>
          <input type="text" id="kac-msg" />
        </div>
        <div class="kac-grid">
          <div class="kac-row">
            <label>Interval (s)</label>
            <input type="number" id="kac-int" min="1" step="1" />
          </div>
          <div class="kac-row">
            <label>Cooldown (s)</label>
            <input type="number" id="kac-cool" min="0" step="1" />
          </div>
        </div>
        <label class="kac-check"><input type="checkbox" id="kac-dup" /> Anti-duplicate (avoid Kick's repeat filter)</label>
        <div class="kac-btns">
          <button class="kac-btn" id="kac-toggle">Start</button>
          <button class="kac-btn" id="kac-now">Send now</button>
        </div>
        <div id="kac-status"></div>
        <div id="kac-log"></div>
      </div>
    `;
    document.body.appendChild(p);

    ui = {
      panel: p,
      head: p.querySelector('#kac-head'),
      dot: p.querySelector('#kac-dot'),
      collapse: p.querySelector('#kac-collapse'),
      body: p.querySelector('#kac-body'),
      msg: p.querySelector('#kac-msg'),
      int: p.querySelector('#kac-int'),
      cool: p.querySelector('#kac-cool'),
      dup: p.querySelector('#kac-dup'),
      toggle: p.querySelector('#kac-toggle'),
      now: p.querySelector('#kac-now'),
      status: p.querySelector('#kac-status'),
      log: p.querySelector('#kac-log'),
    };

    // Restore values
    ui.msg.value = settings.message;
    ui.int.value = settings.intervalSec;
    ui.cool.value = settings.cooldownSec;
    ui.dup.checked = settings.antiDup;
    if (settings.pos.left != null) {
      p.style.left = settings.pos.left + 'px';
      p.style.top = settings.pos.top + 'px';
      p.style.right = 'auto';
    }
    if (settings.collapsed) ui.body.classList.add('hidden');

    // Wire events
    ui.msg.addEventListener('input', () => { settings.message = ui.msg.value; saveSettings(); });
    ui.int.addEventListener('input', () => {
      settings.intervalSec = Math.max(1, parseInt(ui.int.value, 10) || 1); saveSettings();
      if (settings.running) scheduleNext();
    });
    ui.cool.addEventListener('input', () => {
      settings.cooldownSec = Math.max(0, parseInt(ui.cool.value, 10) || 0); saveSettings();
      if (settings.running) scheduleNext();
    });
    ui.dup.addEventListener('change', () => { settings.antiDup = ui.dup.checked; saveSettings(); });
    ui.toggle.addEventListener('click', () => settings.running ? stop() : start());
    ui.now.addEventListener('click', sendNow);
    ui.collapse.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      ui.body.classList.toggle('hidden', settings.collapsed);
      saveSettings();
    });

    makeDraggable(p, ui.head);
    syncControls();
    updateStatus();
  }

  function makeDraggable(panel, handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target === ui.collapse) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let left = e.clientX - ox;
      let top = e.clientY - oy;
      left = Math.max(0, Math.min(window.innerWidth - 40, left));
      top = Math.max(0, Math.min(window.innerHeight - 20, top));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      settings.pos = { left: Math.round(r.left), top: Math.round(r.top) };
      saveSettings();
    });
  }

  function syncControls() {
    if (!ui.toggle) return;
    ui.toggle.textContent = settings.running ? 'Stop' : 'Start';
    ui.toggle.className = 'kac-btn ' + (settings.running ? 'stop' : 'start');
    ui.dot.classList.toggle('on', settings.running);
  }

  function updateStatus() {
    if (!ui.status) return;
    if (settings.running) {
      const secs = Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000));
      ui.status.innerHTML = `Running — next in <b>${secs}s</b> · sent ${sendCount}`;
    } else {
      ui.status.innerHTML = `Idle · sent ${sendCount}`;
    }
  }

  function log(msg, isErr) {
    if (!ui.log) return;
    const t = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    if (isErr) line.className = 'err';
    line.textContent = `[${t}] ${msg}`;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
    // keep last ~40 lines
    while (ui.log.childNodes.length > 40) ui.log.removeChild(ui.log.firstChild);
  }

  // ----------------------------------------------------------------------
  // Boot — wait until the page body exists, then mount.
  // ----------------------------------------------------------------------
  function boot() {
    injectStyles();
    buildPanel();
    if (settings.running) {
      // Resume after navigation/reload if it was left running.
      scheduleNext();
      if (!tickTimer) tickTimer = setInterval(tick, 1000);
      syncControls();
    }
  }

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
