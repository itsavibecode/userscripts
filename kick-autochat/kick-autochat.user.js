// ==UserScript==
// @name         Kick Auto-Chat (iceposeidon)
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.5.0
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
    targetChannel: 'iceposeidon', // only sends on kick.com/<this>; paused everywhere else
    message: 'Cx',
    intervalSec: 65,   // base time between sends
    cooldownSec: 65,   // minimum gap that MUST pass since last successful send
    antiDup: true,     // append a varying zero-width char so Kick won't reject duplicates
    rotateKeywords: '', // comma-separated extra messages to rotate through (only used when antiDup is on)
    running: false,
    collapsed: false,
    pos: { left: null, top: null },
    size: { w: null, h: null }, // panel width/height in px once the user resizes
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
  let rotateIndex = 0;        // position in the rotation pool

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

  // ----------------------------------------------------------------------
  // Target-channel gating. The panel shows on every kick.com page, but sends
  // only happen on the configured channel — so navigating to another streamer
  // (in this tab or another) never posts there.
  // ----------------------------------------------------------------------

  // Normalize whatever the user typed (username, @handle, or a full kick URL)
  // down to a bare lowercase channel slug.
  function normChannel(v) {
    if (!v) return '';
    v = String(v).trim();
    const m = v.match(/kick\.com\/([^/?#]+)/i);
    if (m) v = m[1];
    return v.replace(/^@+/, '').replace(/[/?#].*$/, '').trim().toLowerCase();
  }

  // The channel slug of the page we're currently on (first path segment).
  function currentChannel() {
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    return seg.toLowerCase();
  }

  function targetChannel() {
    return normChannel(settings.targetChannel);
  }

  function isOnTarget() {
    const t = targetChannel();
    return !!t && currentChannel() === t;
  }

  // Returns the list of texts currently in rotation: the main Message plus any
  // comma-separated keywords (the keywords only count when anti-duplicate is on).
  function rotationPool() {
    let pool = [settings.message];
    if (settings.antiDup && settings.rotateKeywords) {
      const extra = settings.rotateKeywords.split(',').map(s => s.trim()).filter(Boolean);
      pool = pool.concat(extra);
    }
    pool = pool.filter(s => s && s.length > 0);
    return pool.length ? pool : [settings.message];
  }

  function buildMessage() {
    const pool = rotationPool();
    const base = pool[rotateIndex % pool.length];
    rotateIndex = (rotateIndex + 1) % pool.length;

    let msg = base;
    if (settings.antiDup) {
      // Append N invisible zero-width spaces so Kick doesn't see an identical
      // consecutive message. Cycles 0..5 so it never grows unbounded. This also
      // covers the case where two rotation entries happen to be the same word.
      dupCounter = (dupCounter + 1) % 6;
      msg += '​'.repeat(dupCounter);
    }
    return msg;
  }

  // Insert text into a contenteditable (Lexical/ProseMirror friendly) or a
  // textarea, then submit. Returns true if a send was attempted.
  function sendMessage() {
    // Hard safety net: never post unless we're on the target channel.
    if (!isOnTarget()) return false;
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
    log(`Sent #${sendCount}: "${text.replace(/​/g, '')}"`);
    updateStatus();
    checkWaitAfterSend();
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
  // Slow-mode / rate-limit detection.
  // After a send, Kick may refuse it and show a notice like
  // "Wait 5 seconds before sending another message" (slow mode), or a generic
  // "you are sending messages too quickly". We scan short notice elements near
  // the chat box for that text, log it in the GUI, and delay the next send.
  // ----------------------------------------------------------------------
  const WAIT_RE = /\bwait\s+(\d+(?:\.\d+)?)\s*second/i;
  const SLOW_RE = /(slow ?mode|sending (?:messages )?too (?:fast|quickly)|too many messages)/i;
  let lastWaitNotice = { text: '', at: 0 };

  function scanForWaitNotice() {
    const texts = [];
    const push = (t) => { if (t && t.length > 0 && t.length < 200) texts.push(t); };

    const input = findInput();
    if (input) {
      push(input.getAttribute('placeholder'));
      // The footer/form wrapping the input is where Kick usually drops the notice.
      const wrap = input.closest('form') || input.parentElement;
      if (wrap) push(wrap.textContent);
    }

    const btn = findSendButton();
    if (btn) { push(btn.textContent); push(btn.getAttribute('aria-label')); }

    // Generic notice/toast/error containers (class match is case-insensitive).
    const sel = '[role="alert"], [class*="error" i], [class*="toast" i], ' +
                '[class*="notif" i], [class*="warn" i], [class*="slow" i]';
    document.querySelectorAll(sel).forEach((el) => push(el.textContent));

    for (const raw of texts) {
      const t = raw.replace(/\s+/g, ' ').trim();
      const m = t.match(WAIT_RE);
      if (m) return { text: t.slice(0, 120), secs: parseFloat(m[1]) };
      if (SLOW_RE.test(t)) return { text: t.slice(0, 120), secs: null };
    }
    return null;
  }

  function handleWaitNotice(n) {
    const now = Date.now();
    // Debounce: don't log the same notice repeatedly within 5s.
    if (n.text === lastWaitNotice.text && now - lastWaitNotice.at < 5000) return;
    lastWaitNotice = { text: n.text, at: now };

    if (n.secs != null) {
      log(`Kick slow-mode: "${n.text}" — delaying next send ${n.secs}s`, true);
      if (settings.running) {
        nextSendAt = Math.max(nextSendAt, now + n.secs * 1000 + 500);
        updateStatus();
      }
    } else {
      log(`Kick blocked the send: "${n.text}"`, true);
    }
  }

  // Poll a few times after a send, since the notice may appear with a slight lag.
  function checkWaitAfterSend() {
    [150, 450, 900, 1600].forEach((d) => setTimeout(() => {
      const n = scanForWaitNotice();
      if (n) handleWaitNotice(n);
    }, d));
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
    if (now >= nextSendAt && isOnTarget()) {
      // Off-target ticks are skipped WITHOUT rescheduling, so the moment you
      // return to the target channel it sends right away, then resumes timing.
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
    if (!isOnTarget()) {
      log(`Blocked — not on @${targetChannel() || '(unset)'} (here: @${currentChannel() || '—'})`, true);
      return;
    }
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
        min-width:210px;display:flex;flex-direction:column;
        background:#0f0f12;color:#e7e7ea;font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;
        border:1px solid #2a2a30;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);
        user-select:none;overflow:hidden}
      #kac-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;
        background:linear-gradient(90deg,#1b2f1b,#13131a);border-bottom:1px solid #2a2a30}
      #kac-head .dot{width:8px;height:8px;border-radius:50%;background:#666;flex:0 0 auto}
      #kac-head .dot.on{background:#53fc18;box-shadow:0 0 8px #53fc18}
      #kac-title{font-weight:700;letter-spacing:.3px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #kac-collapse{cursor:pointer;background:none;border:none;color:#9a9aa3;font-size:14px;padding:0 2px}
      #kac-body{padding:10px;display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:hidden}
      #kac-body.hidden{display:none}
      .kac-row.hidden{display:none}
      .kac-row{display:flex;flex-direction:column;gap:3px}
      .kac-row label{color:#9a9aa3;font-size:11px;cursor:help;display:flex;align-items:center;gap:4px}
      .kac-q{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;
        border-radius:50%;background:#2a2a30;color:#9a9aa3;font-size:9px;font-weight:700;cursor:help}
      #kac-status,#kac-log{cursor:help}
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
        border-radius:6px;padding:6px;flex:1 1 auto;min-height:64px;overflow:auto;white-space:pre-wrap}
      #kac-log .err{color:#ff7b7b}
      #kac-resize{position:absolute;right:2px;bottom:2px;width:15px;height:15px;cursor:nwse-resize;
        background:
          linear-gradient(135deg,transparent 0 48%,#5a5a63 48% 56%,transparent 56% 70%,#5a5a63 70% 78%,transparent 78%);
        border-bottom-right-radius:8px;opacity:.8}
      #kac-resize:hover{opacity:1}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'kac-panel';
    p.innerHTML = `
      <div id="kac-head" title="Drag this bar to move the panel. The green dot lights up while auto-sending is running.">
        <span class="dot" id="kac-dot" title="Status light: green = running, grey = idle/stopped."></span>
        <span id="kac-title">Kick Auto-Chat</span>
        <button id="kac-collapse" title="Collapse / expand the panel. State is remembered.">_</button>
      </div>
      <div id="kac-body">
        <div class="kac-row">
          <label title="The bot ONLY sends on kick.com/<this username>. On any other channel or tab it shows Paused and posts nothing. You can type a username, an @handle, or paste a full kick.com URL.">Target channel <span class="kac-q">?</span></label>
          <input type="text" id="kac-target" placeholder="iceposeidon"
            title="Only auto-send on this Kick channel. Example: iceposeidon. Navigate to a different streamer and the bot pauses automatically — it will not chat there." />
        </div>
        <div class="kac-row">
          <label title="The exact text sent to chat each time. Default is Cx. Changes are saved automatically and used on the next send.">Message <span class="kac-q">?</span></label>
          <input type="text" id="kac-msg"
            title="The exact text sent to chat each time. Default is Cx. Changes save automatically and apply to the next send." />
        </div>
        <div class="kac-grid">
          <div class="kac-row">
            <label title="Interval: your normal rhythm — how often the auto-loop sends, in seconds. This is the dial you'll usually use.">Interval (s) <span class="kac-q">?</span></label>
            <input type="number" id="kac-int" min="1" step="1"
              title="INTERVAL = normal rhythm. Send roughly every N seconds (default 65). The countdown below counts down this value after each send. If you set this lower than Cooldown, Cooldown wins." />
          </div>
          <div class="kac-row">
            <label title="Cooldown: a minimum spacing floor. The loop never sends two messages closer together than this, even if Interval is lower. Safety guard against Kick slow-mode / rate limits.">Cooldown (s) <span class="kac-q">?</span></label>
            <input type="number" id="kac-cool" min="0" step="1"
              title="COOLDOWN = minimum gap floor. Two auto-sends will never be closer than N seconds apart, regardless of Interval. The script waits for whichever is longer (Interval or Cooldown). Set to 0 to disable the floor. 'Send now' ignores this." />
          </div>
        </div>
        <label class="kac-check"
          title="Kick rejects an identical message sent twice in a row ('you already sent this message'). When on, the script appends 0-5 invisible zero-width characters that cycle each send, so repeated text like Cx still posts, and the rotation field below becomes active. Recommended ON.">
          <input type="checkbox" id="kac-dup" /> Anti-duplicate (avoid Kick's repeat filter)</label>
        <div class="kac-row" id="kac-rotate-row">
          <label title="Extra messages to cycle through, separated by commas. The Message above is always first, then each keyword in turn, then it loops. Example: KEKW, LULW, Cx W. Whitespace around commas is trimmed; blank entries are ignored. Only used while Anti-duplicate is on.">Rotation keywords (comma-separated) <span class="kac-q">?</span></label>
          <input type="text" id="kac-rotate" placeholder="e.g. KEKW, LULW, Cx W"
            title="Comma-separated list of additional messages. Sends cycle: Message, then each keyword, then loop. Leave empty to just send the Message. Only active while Anti-duplicate is checked." />
        </div>
        <div class="kac-btns">
          <button class="kac-btn" id="kac-toggle"
            title="Start / Stop the auto-sender. While running, messages send on the Interval/Cooldown timer even if this tab is in the background (no window focus needed).">Start</button>
          <button class="kac-btn" id="kac-now"
            title="Send the message one time, right now. Manual override — ignores the Interval and Cooldown timers. Useful for testing that sending works.">Send now</button>
        </div>
        <div id="kac-status"
          title="Live status: shows whether it's running, the countdown to the next send, and how many messages have been sent this session."></div>
        <div id="kac-log"
          title="Activity log: timestamped record of sends, start/stop, and any errors (e.g. 'Chat input not found'). Keeps the last ~40 lines. Drag the corner grip to make this taller."></div>
      </div>
      <div id="kac-resize" title="Drag to resize the panel — the log grows to fill the extra space."></div>
    `;
    document.body.appendChild(p);

    ui = {
      panel: p,
      head: p.querySelector('#kac-head'),
      titleEl: p.querySelector('#kac-title'),
      dot: p.querySelector('#kac-dot'),
      collapse: p.querySelector('#kac-collapse'),
      body: p.querySelector('#kac-body'),
      target: p.querySelector('#kac-target'),
      msg: p.querySelector('#kac-msg'),
      int: p.querySelector('#kac-int'),
      cool: p.querySelector('#kac-cool'),
      dup: p.querySelector('#kac-dup'),
      rotate: p.querySelector('#kac-rotate'),
      rotateRow: p.querySelector('#kac-rotate-row'),
      toggle: p.querySelector('#kac-toggle'),
      now: p.querySelector('#kac-now'),
      status: p.querySelector('#kac-status'),
      log: p.querySelector('#kac-log'),
      resize: p.querySelector('#kac-resize'),
    };

    // Restore values
    ui.target.value = settings.targetChannel;
    ui.msg.value = settings.message;
    ui.int.value = settings.intervalSec;
    ui.cool.value = settings.cooldownSec;
    ui.dup.checked = settings.antiDup;
    ui.rotate.value = settings.rotateKeywords;
    ui.rotateRow.classList.toggle('hidden', !settings.antiDup);
    if (settings.pos.left != null) {
      p.style.left = settings.pos.left + 'px';
      p.style.top = settings.pos.top + 'px';
      p.style.right = 'auto';
    }
    if (settings.collapsed) ui.body.classList.add('hidden');
    applySize();

    // Wire events
    ui.target.addEventListener('input', () => {
      settings.targetChannel = ui.target.value;
      saveSettings();
      updateStatus();
    });
    ui.msg.addEventListener('input', () => { settings.message = ui.msg.value; saveSettings(); });
    ui.int.addEventListener('input', () => {
      settings.intervalSec = Math.max(1, parseInt(ui.int.value, 10) || 1); saveSettings();
      if (settings.running) scheduleNext();
    });
    ui.cool.addEventListener('input', () => {
      settings.cooldownSec = Math.max(0, parseInt(ui.cool.value, 10) || 0); saveSettings();
      if (settings.running) scheduleNext();
    });
    ui.dup.addEventListener('change', () => {
      settings.antiDup = ui.dup.checked;
      ui.rotateRow.classList.toggle('hidden', !settings.antiDup);
      rotateIndex = 0;
      saveSettings();
    });
    ui.rotate.addEventListener('input', () => {
      settings.rotateKeywords = ui.rotate.value;
      rotateIndex = 0; // restart the cycle when the list changes
      saveSettings();
    });
    ui.toggle.addEventListener('click', () => settings.running ? stop() : start());
    ui.now.addEventListener('click', sendNow);
    ui.collapse.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      ui.body.classList.toggle('hidden', settings.collapsed);
      applySize();
      updateStatus();
      saveSettings();
    });

    makeDraggable(p, ui.head);
    makeResizable(p, ui.resize);
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

  // Apply the saved panel size. Height is only applied when expanded — collapsed
  // the panel hugs the header.
  function applySize() {
    const p = ui.panel;
    p.style.width = settings.size.w ? settings.size.w + 'px' : '';
    p.style.height = (settings.size.h && !settings.collapsed) ? settings.size.h + 'px' : '';
  }

  function makeResizable(panel, handle) {
    let rz = false, sx = 0, sy = 0, sw = 0, sh = 0;
    handle.addEventListener('mousedown', (e) => {
      rz = true;
      const r = panel.getBoundingClientRect();
      // Anchor by left/top so the panel grows toward the bottom-right.
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.right = 'auto';
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!rz) return;
      let w = Math.round(sw + (e.clientX - sx));
      let h = Math.round(sh + (e.clientY - sy));
      w = Math.max(210, Math.min(680, w));
      h = Math.max(170, Math.min(Math.round(window.innerHeight * 0.92), h));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!rz) return;
      rz = false;
      const r = panel.getBoundingClientRect();
      settings.size = { w: Math.round(r.width), h: Math.round(r.height) };
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
    const target = targetChannel() || '(unset)';

    // Running but on the wrong channel → paused, nothing is sent here.
    if (settings.running && !isOnTarget()) {
      ui.status.innerHTML = `Paused — not on <b>@${target}</b> (here: @${currentChannel() || '—'})`;
      ui.titleEl.textContent = settings.collapsed
        ? `Paused @${target}`
        : `Kick Auto-Chat · paused`;
      return;
    }

    if (settings.running) {
      const secs = Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000));
      ui.status.innerHTML = `Running on <b>@${target}</b> — next in <b>${secs}s</b> · sent ${sendCount}`;
      // Mirror into the title bar so it's visible even when collapsed.
      ui.titleEl.textContent = settings.collapsed
        ? `${secs}s · ${sendCount} sent`
        : `Kick Auto-Chat · ${secs}s · ${sendCount} sent`;
    } else {
      ui.status.innerHTML = `Idle · target @${target} · sent ${sendCount}`;
      ui.titleEl.textContent = settings.collapsed
        ? `Idle · ${sendCount} sent`
        : 'Kick Auto-Chat';
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
