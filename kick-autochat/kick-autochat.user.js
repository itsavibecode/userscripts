// ==UserScript==
// @name         Kick Auto-Chat (iceposeidon)
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.23.0
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

  // Read the running version from the userscript metadata so the footer always
  // matches the @version header (fallback string only used if GM_info is absent).
  const VERSION =
    (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.5.1';

  // ----------------------------------------------------------------------
  // Persistent settings (localStorage, per-origin)
  // ----------------------------------------------------------------------
  const STORE_KEY = 'kick-autochat:settings';
  const DEFAULTS = {
    targetChannel: 'iceposeidon', // only sends on kick.com/<this>; paused everywhere else
    message: 'Cx',
    intervalSec: 110,  // base/min time between sends
    cooldownSec: 4,    // minimum gap that MUST pass since last successful send
    randomize: true,       // pick interval/cooldown randomly between min and max each cycle
    intervalMaxSec: 119,   // upper bound for interval when randomize is on (min = intervalSec)
    cooldownMaxSec: 19,    // upper bound for cooldown when randomize is on (min = cooldownSec)
    antiDup: true,     // append a varying zero-width char so Kick won't reject duplicates
    rotateKeywords: '', // comma-separated extra messages to rotate through (only used when antiDup is on)
    secondEnabled: true,    // a second message on its own long timer (e.g. !claim)
    secondMessage: '!claim',// sent verbatim, no rotation/anti-dup
    secondValue: 4,         // how often (number)
    secondUnit: 'hours',    // 'minutes' | 'hours'
    watchEnabled: false,    // watch chat for @mentions / replies to your username
    watchUsername: '',      // your own Kick username (exact)
    watchSound: true,       // beep on a new mention
    watchBareName: false,   // also match your username with no @ in front
    // Senders the watcher skips (comma-separated). Pre-filled with the usual
    // Kick bots — the points bot answering !claim would otherwise ping you
    // every time. Fully editable; add whatever you like.
    ignoreSenders: 'Botrix, StreamElements, Fossabot, Nightbot',
    webhookEnabled: false,  // POST each mention to a webhook
    webhookUrl: '',         // Discord webhook URL, or any endpoint that accepts JSON
    webhookFormat: 'discord', // 'discord' | 'json'
    running: false,
    collapsed: false,
    explainOpen: true,         // "What will happen" summary expanded
    logOpen: true,             // activity-log drawer open (side-by-side) vs hidden
    pos: { left: null, top: null },
    size: { w: null, h: null }, // controls width/height in px once the user resizes
  };

  // Your saved settings always win over DEFAULTS: an update never rewrites your
  // config. A changed default therefore only affects a fresh install — curated
  // fields (ignore list, keywords, messages) are yours to edit, not ours.
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
    // Every settings change flows through here, so this keeps the live
    // "What will happen" summary in sync with the controls.
    updateExplain();
  }

  const settings = loadSettings();

  // ----------------------------------------------------------------------
  // Runtime state
  // ----------------------------------------------------------------------
  let tickTimer = null;       // 1s UI/scheduler tick
  let nextSendAt = 0;         // epoch ms of the next scheduled send
  let lastSendAt = 0;         // epoch ms of the last successful send
  let sendCount = 0;
  let secondNextSendAt = 0;   // epoch ms of the next scheduled (second) send
  let secondCount = 0;
  let dupCounter = 0;         // drives the anti-duplicate varying suffix
  let rotateIndex = 0;        // position in the rotation pool (sequential mode)
  let lastBase = null;        // last text sent, so random mode never repeats it back-to-back
  let watchTimer = null;      // 1s poll scanning chat for mentions
  let watcherSeeded = false;  // have we marked the on-screen backlog as already seen?
  // Signatures of chat lines already handled. We can NOT key this on data-index:
  // Kick caps its chat buffer, so once it fills, the virtualiser stops handing out
  // ever-increasing indices and an index high-water mark silently skips everything.
  const seenLines = new Set();
  let activeTab = 'log';      // which drawer tab is showing ('log' | 'men')
  let unreadMen = 0;          // unseen mention count (for the badge)
  let menTotal = 0;           // total mentions caught this session

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
    // De-duplicate exact repeats so random selection is fair and two identical
    // entries can't cause a back-to-back repeat.
    pool = [...new Set(pool)];
    return pool.length ? pool : [settings.message];
  }

  function buildMessage() {
    const pool = rotationPool();
    let base;
    if (settings.randomize && pool.length > 1) {
      // Random order, but never the same text twice in a row (more human).
      let attempts = 0;
      do {
        base = pool[Math.floor(Math.random() * pool.length)];
        attempts++;
      } while (base === lastBase && attempts < 12);
    } else {
      // Fixed rotation: step through the pool in order.
      base = pool[rotateIndex % pool.length];
      rotateIndex = (rotateIndex + 1) % pool.length;
    }
    lastBase = base;

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

  // Core: insert an exact string into a contenteditable (Lexical/ProseMirror
  // friendly) or a textarea, then submit. Returns true if a send was attempted.
  // Used by both the main message and the scheduled message.
  function sendRaw(text) {
    // Hard safety net: never post unless we're on the target channel.
    if (!isOnTarget()) return false;
    const input = findInput();
    if (!input) {
      log('Chat input not found — is chat loaded / are you logged in?', true);
      return false;
    }

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

    lastSendAt = Date.now();
    checkWaitAfterSend();
    return true;
  }

  // Main rotating/anti-dup message.
  function sendMessage() {
    const text = buildMessage();
    if (!sendRaw(text)) return false;
    sendCount++;
    log(`Sent #${sendCount}: "${text.replace(/​/g, '')}"`);
    updateStatus();
    return true;
  }

  // Scheduled message — sent verbatim (no rotation, no anti-dup char) so chat
  // commands like !claim are recognized exactly.
  function sendSecond() {
    const text = (settings.secondMessage || '').trim();
    if (!text) return false;
    if (!sendRaw(text)) return false;
    secondCount++;
    log(`Scheduled send: "${text}"`);
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
  // Pick a value for this cycle: the fixed min, or a random whole number in
  // [min, max] when randomize is on (order-safe if max < min).
  function pickSeconds(minV, maxV) {
    if (!settings.randomize) return minV;
    const lo = Math.min(minV, maxV);
    const hi = Math.max(minV, maxV);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function scheduleNext() {
    const now = Date.now();
    const iv = pickSeconds(settings.intervalSec, settings.intervalMaxSec);
    const cd = pickSeconds(settings.cooldownSec, settings.cooldownMaxSec);
    // Next send respects BOTH the interval and the minimum cooldown gap.
    const byInterval = now + iv * 1000;
    const byCooldown = lastSendAt + cd * 1000;
    nextSendAt = Math.max(byInterval, byCooldown);
  }

  // The scheduled (second) message interval in milliseconds.
  function secondIntervalMs() {
    const v = Math.max(1, settings.secondValue || 1);
    const mult = settings.secondUnit === 'hours' ? 3600 : 60;
    return v * mult * 1000;
  }
  function scheduleSecond() {
    secondNextSendAt = Date.now() + secondIntervalMs();
  }

  function tick() {
    if (!settings.running) return;
    const now = Date.now();
    if (!isOnTarget()) { updateStatus(); return; }

    // Minimum spacing between ANY two sends (main or scheduled), so the two
    // timers can never post closer together than the cooldown.
    const gap = Math.max(settings.cooldownSec, 3) * 1000;

    // Priority 1: the scheduled message (e.g. !claim). It fires less often, so
    // when it's due it takes precedence. We also require the cooldown gap since
    // the last send, so it never lands right on top of a regular message.
    if (settings.secondEnabled && (settings.secondMessage || '').trim()
        && now >= secondNextSendAt && now >= lastSendAt + gap) {
      sendSecond();
      scheduleSecond();
      nextSendAt = Math.max(nextSendAt, lastSendAt + gap);
      updateStatus();
      return; // skip the main message this tick
    }

    // Priority 2: the main rotating message (scheduleNext already enforces the
    // cooldown floor against lastSendAt).
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
    scheduleSecond();
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
      #kac-panel{position:fixed;z-index:2147483647;top:90px;right:16px;
        display:flex;flex-direction:row;align-items:stretch;gap:8px;
        color:#e7e7ea;font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;user-select:none}
      #kac-main{position:relative;display:flex;flex-direction:column;width:248px;min-width:210px;
        background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden}
      #kac-drawer{display:flex;flex-direction:column;width:300px;min-width:170px;align-self:stretch;
        background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden}
      #kac-drawer-head{flex:0 0 auto;display:flex;gap:4px;background:#13131a;border-bottom:1px solid #2a2a30}
      .kac-tab{flex:1;cursor:pointer;background:none;border:none;color:#9a9aa3;font:inherit;font-weight:700;
        padding:8px 6px;border-bottom:2px solid transparent;display:flex;align-items:center;justify-content:center;gap:5px}
      .kac-tab.active{color:#e7e7ea;border-bottom-color:#53fc18}
      #kac-clear{flex:0 0 auto;cursor:pointer;background:none;border:none;border-left:1px solid #2a2a30;
        color:#9a9aa3;font:inherit;font-size:10px;padding:0 8px}
      #kac-clear:hover{color:#e7e7ea}
      .kac-badge{display:none;min-width:15px;padding:0 4px;border-radius:8px;background:#ff4757;color:#fff;
        font-size:9px;font-weight:700;text-align:center;line-height:15px}
      #kac-mentions{flex:1 1 auto;min-height:0;overflow:auto;padding:6px;font-size:10.5px;background:#0a0a0d}
      #kac-tab-set{flex:0 0 32px}
      #kac-settings{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px;
        display:flex;flex-direction:column;gap:8px;background:#0f0f12}
      .kac-set-h{font-size:9.5px;font-weight:700;letter-spacing:.4px;color:#9a9aa3}
      .kac-men-item{color:#e7e7ea;padding:3px 4px;border-bottom:1px solid #16161b;word-break:break-word}
      .kac-men-item.reply{border-left:2px solid #9ad4ff;padding-left:4px}
      .kac-men-item.quote{border-left:2px solid #ffc266;padding-left:4px}
      .kac-men-t{color:#6f6f78}
      .kac-men-s{color:#53fc18;font-weight:700}
      .kac-men-item.reply .kac-men-s{color:#9ad4ff}
      .kac-men-item.quote .kac-men-s{color:#ffc266}
      .kac-men-q{color:#6f6f78;font-size:9.5px;padding-left:8px;margin-top:1px}
      #kac-logtab{cursor:pointer;background:none;border:none;color:#9a9aa3;font-size:12px;padding:0 4px}
      #kac-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;
        background:linear-gradient(90deg,#1b2f1b,#13131a);border-bottom:1px solid #2a2a30}
      #kac-head .dot{width:8px;height:8px;border-radius:50%;background:#666;flex:0 0 auto}
      #kac-head .dot.on{background:#53fc18;box-shadow:0 0 8px #53fc18}
      #kac-title{font-weight:700;letter-spacing:.3px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #kac-collapse{cursor:pointer;background:none;border:none;color:#9a9aa3;font-size:14px;padding:0 2px}
      #kac-body{padding:10px;display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;
        overflow-y:auto;overflow-x:hidden}
      #kac-body.hidden{display:none}
      .kac-row.hidden{display:none}
      .kac-row{display:flex;flex-direction:column;gap:3px}
      .kac-row label{color:#9a9aa3;font-size:11px;cursor:help;display:flex;align-items:center;gap:4px}
      .kac-q{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;
        border-radius:50%;background:#2a2a30;color:#9a9aa3;font-size:9px;font-weight:700;cursor:help}
      #kac-status,#kac-log{cursor:help}
      .kac-row input[type=text],.kac-row input[type=number],.kac-row select{background:#17171c;border:1px solid #2a2a30;
        color:#e7e7ea;border-radius:6px;padding:6px 8px;font:inherit;width:100%;box-sizing:border-box}
      .kac-div{height:1px;background:#2a2a30;margin:3px 0 1px}
      .kac-group{border-radius:8px;padding:7px;border:1px solid}
      .kac-g-title{font-size:9.5px;font-weight:700;letter-spacing:.4px;margin-bottom:5px}
      .kac-g-int{background:rgba(83,252,24,.06);border-color:rgba(83,252,24,.30)}
      .kac-g-int .kac-g-title{color:#7ee85a}
      .kac-g-cool{background:rgba(120,160,255,.07);border-color:rgba(120,160,255,.32)}
      .kac-g-cool .kac-g-title{color:#93b4ff}
      .kac-g-read{font-size:10px;font-weight:700;margin-bottom:4px;line-height:1.35}
      .kac-g-int .kac-g-read{color:#bdf5a8}
      .kac-g-cool .kac-g-read{color:#c3d6ff}
      .kac-mmss{display:flex;align-items:center;gap:4px;margin-top:5px}
      .kac-mmss.hidden{display:none}
      .kac-mmss-lbl{flex:0 0 34px;font-size:10px;color:#9a9aa3}
      .kac-mmss input[type=number]{flex:1 1 auto;min-width:0;width:100%;box-sizing:border-box;
        background:#17171c;border:1px solid #2a2a30;color:#e7e7ea;border-radius:6px;
        padding:5px 4px;font:inherit;text-align:center}
      .kac-u{flex:0 0 auto;font-size:10px;color:#9a9aa3}
      .kac-inat{display:flex;align-items:center;gap:2px;background:#17171c;border:1px solid #2a2a30;border-radius:6px;padding-left:8px}
      .kac-inat span{color:#9a9aa3;font-weight:700;font-size:12px}
      .kac-inat input[type=text]{border:none;background:transparent;flex:1 1 auto;width:auto;padding-left:2px}
      #kac-sec-status{font-size:11px;color:#9a9aa3;min-height:14px;cursor:help}
      #kac-sec-status b{color:#53fc18}
      .kac-grid{display:flex;gap:8px}
      .kac-grid .kac-row{flex:1}
      .kac-check{display:flex;align-items:center;gap:6px;color:#cfcfd6;cursor:pointer}
      .kac-btns{display:flex;gap:8px;margin-top:2px}
      .kac-btn{flex:1;border:none;border-radius:7px;padding:8px;font:inherit;font-weight:700;cursor:pointer}
      #kac-toggle.start{background:#53fc18;color:#0a0a0a}
      #kac-toggle.stop{background:#ff4757;color:#fff}
      #kac-now{background:#2a2a30;color:#e7e7ea}
      .kac-btn-sm{background:#2a2a30;color:#e7e7ea;font-size:10px;padding:6px;font-weight:600}
      .kac-btn-sm:hover{background:#35353d}
      #kac-status{font-size:11px;color:#9a9aa3;min-height:14px}
      #kac-status b{color:#53fc18}
      #kac-watch-btn{background:#53fc18;color:#0a0a0a}
      #kac-watch-btn.watching{background:#ff4757;color:#fff}
      #kac-watch-status{font-size:11px;color:#9a9aa3;min-height:14px}
      #kac-watch-status b{color:#53fc18}
      #kac-log{font-size:10.5px;color:#7d7d85;background:#0a0a0d;
        padding:6px;flex:1 1 auto;min-height:0;overflow:auto;white-space:pre-wrap}
      #kac-log .err{color:#ff7b7b}
      #kac-explain{font-size:10px;line-height:1.45;border-radius:8px;padding:6px 7px;
        background:rgba(255,184,77,.07);border:1px solid rgba(255,184,77,.30)}
      #kac-explain-head{display:flex;align-items:center;justify-content:space-between;gap:6px;
        color:#ffc266;font-weight:700;font-size:9.5px;letter-spacing:.4px;cursor:pointer;user-select:none}
      #kac-explain-body{margin-top:4px;color:#cbb894}
      #kac-explain-body.hidden{display:none}
      #kac-explain-body div{padding:1px 0}
      #kac-foot{flex:0 0 auto;font-size:9.5px;color:#5a5a63;text-align:right;padding-right:14px;cursor:default}
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
      <div id="kac-main">
      <div id="kac-head" title="Drag this bar to move the panel. The green dot lights up while auto-sending is running.">
        <span class="dot" id="kac-dot" title="Status light: green = running, grey = idle/stopped."></span>
        <span id="kac-title">Kick Auto-Chat</span>
        <button id="kac-logtab" title="Show / hide the log & mentions panel on the right.">◀</button>
        <span id="kac-logtab-badge" class="kac-badge" title="Unseen mentions — open the panel and click the Mentions tab to view them.">0</span>
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
        <label class="kac-check"
          title="When on: (1) each send waits a RANDOM whole number of seconds between the Min and Max of each coloured group below, re-rolled every cycle; and (2) rotation keywords are sent in RANDOM order, never the same one twice in a row. Makes the bot look less robotic.">
          <input type="checkbox" id="kac-rand" /> Randomize timing &amp; keyword order</label>
        <div class="kac-group kac-g-int"
          title="INTERVAL group — how often it sends. Each row's minutes and seconds boxes ADD TOGETHER (2m + 32s = 2m 32s). The green readout above shows exactly what the script understands.">
          <div class="kac-g-title">INTERVAL — how often it sends</div>
          <div class="kac-g-read" id="kac-int-read"></div>
          <div class="kac-mmss">
            <span class="kac-mmss-lbl" id="kac-int-lbl">Every</span>
            <input type="number" id="kac-int-m" min="0" step="1"
              title="Minutes part of the interval. Adds to the seconds box beside it." />
            <span class="kac-u">m</span>
            <input type="number" id="kac-int-s" min="0" max="59" step="1"
              title="Seconds part of the interval. Adds to the minutes box beside it — 2m + 32s means 2 minutes 32 seconds. Over 59 rolls into minutes automatically." />
            <span class="kac-u">s</span>
          </div>
          <div class="kac-mmss" id="kac-int-max-cell">
            <span class="kac-mmss-lbl">Max</span>
            <input type="number" id="kac-int-max-m" min="0" step="1"
              title="Minutes part of the maximum interval. Adds to the seconds box beside it." />
            <span class="kac-u">m</span>
            <input type="number" id="kac-int-max-s" min="0" max="59" step="1"
              title="Seconds part of the maximum interval. Each send picks a random time between the Min and Max rows." />
            <span class="kac-u">s</span>
          </div>
        </div>
        <div class="kac-group kac-g-cool"
          title="COOLDOWN group — the minimum gap between any two sends. Each row's minutes and seconds boxes ADD TOGETHER. The blue readout above shows exactly what the script understands.">
          <div class="kac-g-title">COOLDOWN — minimum gap between sends</div>
          <div class="kac-g-read" id="kac-cool-read"></div>
          <div class="kac-mmss">
            <span class="kac-mmss-lbl" id="kac-cool-lbl">Gap</span>
            <input type="number" id="kac-cool-m" min="0" step="1"
              title="Minutes part of the cooldown. Adds to the seconds box beside it." />
            <span class="kac-u">m</span>
            <input type="number" id="kac-cool-s" min="0" max="59" step="1"
              title="Seconds part of the cooldown. Adds to the minutes box beside it. Two sends never land closer than this. Over 59 rolls into minutes automatically." />
            <span class="kac-u">s</span>
          </div>
          <div class="kac-mmss" id="kac-cool-max-cell">
            <span class="kac-mmss-lbl">Max</span>
            <input type="number" id="kac-cool-max-m" min="0" step="1"
              title="Minutes part of the maximum cooldown. Adds to the seconds box beside it." />
            <span class="kac-u">m</span>
            <input type="number" id="kac-cool-max-s" min="0" max="59" step="1"
              title="Seconds part of the maximum cooldown. Each cycle picks a random gap between the Min and Max rows." />
            <span class="kac-u">s</span>
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
        <div class="kac-div"></div>
        <label class="kac-check"
          title="A SECOND message on its own long timer (e.g. a bot command like !claim every 4 hours), running alongside the main spammer. When both are due at the same moment, this one takes priority and the main message is held back by the cooldown. Sent EXACTLY as typed (no rotation, no anti-duplicate char) so commands are recognized.">
          <input type="checkbox" id="kac-sec-en" /> Scheduled message (priority)</label>
        <div class="kac-row" id="kac-sec-wrap">
          <label title="Exact text or command to send on the schedule below. Sent verbatim so chat commands like !claim work. No rotation or invisible characters are added.">Message / command <span class="kac-q">?</span></label>
          <input type="text" id="kac-sec-msg" placeholder="!claim"
            title="Exact text/command sent on the schedule. Verbatim — no rotation, no anti-duplicate char." />
          <div class="kac-grid" style="margin-top:6px">
            <div class="kac-row">
              <label title="How often to send the scheduled message (with the unit on the right).">Every <span class="kac-q">?</span></label>
              <input type="number" id="kac-sec-val" min="1" step="1"
                title="How often to send the scheduled message, in the unit chosen on the right. Example: 4 + hours = every 4 hours." />
            </div>
            <div class="kac-row">
              <label title="Time unit for the scheduled interval.">Unit <span class="kac-q">?</span></label>
              <select id="kac-sec-unit" title="Minutes or hours for the scheduled interval.">
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          </div>
          <div id="kac-sec-status"
            title="Countdown to the next scheduled send, and how many have been sent this session."></div>
        </div>
        <div class="kac-div"></div>
        <div class="kac-row">
          <label title="The mention watcher reads the on-page chat for messages that mention or reply to your username and logs them to the Mentions tab. Read-only — it never sends or replies. It is INDEPENDENT of the main Start button and works even when the auto-sender is stopped.">Mention watcher — your Kick username <span class="kac-q">?</span></label>
          <div class="kac-inat" title="Type your username without the @ — the @ is added automatically.">
            <span>@</span>
            <input type="text" id="kac-watch-user" placeholder="your_kick_name"
              title="Type your exact Kick username WITHOUT the @ (it's shown for you). The watcher flags any chat message containing @thisname or a reply to it." />
          </div>
        </div>
        <button class="kac-btn" id="kac-watch-btn"
          title="Start / stop watching chat for @mentions and replies to your username. INDEPENDENT of the main Start button — it works even when the auto-sender is stopped. Matches appear in the Mentions tab.">Start watching</button>
        <div id="kac-watch-status"
          title="Whether the mention watcher is active, and how many mentions it has caught this session."></div>
        <div class="kac-div"></div>
        <div class="kac-btns">
          <button class="kac-btn" id="kac-toggle"
            title="Start / Stop the auto-sender. While running, messages send on the Interval/Cooldown timer even if this tab is in the background (no window focus needed).">Start</button>
          <button class="kac-btn" id="kac-now"
            title="Send the message one time, right now. Manual override — ignores the Interval and Cooldown timers. Useful for testing that sending works.">Send now</button>
        </div>
        <div id="kac-status"
          title="Live status: shows whether it's running, the countdown to the next send, and how many messages have been sent this session."></div>
        <div id="kac-explain">
          <div id="kac-explain-head"
            title="Plain-English summary of exactly what your current settings will do. Updates live as you change anything. Click to collapse or expand — the state is remembered.">
            <span>WHAT WILL HAPPEN</span><span id="kac-explain-arrow">▾</span>
          </div>
          <div id="kac-explain-body"></div>
        </div>
        <div class="kac-div"></div>
        <div class="kac-btns">
          <button class="kac-btn kac-btn-sm" id="kac-export"
            title="Save every setting (target, messages, timings, keywords, scheduled message, watcher, webhook) to a .json file you can keep as a backup. NOTE: the file includes your webhook URL — keep it private.">Backup settings</button>
          <button class="kac-btn kac-btn-sm" id="kac-import"
            title="Load a previously saved .json backup and apply it. Sending is left stopped afterwards so nothing fires unexpectedly — press Start when ready.">Restore</button>
        </div>
        <input type="file" id="kac-import-file" accept="application/json,.json" style="display:none" />
        <div id="kac-foot"
          title="Installed script version. Update via Tampermonkey - Check for userscript updates.">v<span id="kac-ver">?</span></div>
      </div>
      <div id="kac-resize" title="Drag the corner to resize the controls (taller also makes the log taller)."></div>
      </div>
      <div id="kac-drawer">
        <div id="kac-drawer-head">
          <button id="kac-tab-log" class="kac-tab active" title="Activity log: sends, start/stop, and errors.">Log</button>
          <button id="kac-tab-men" class="kac-tab" title="Mentions: messages that @ you or reply to you (needs the watcher enabled below).">Mentions <span id="kac-men-badge" class="kac-badge">0</span></button>
          <button id="kac-tab-set" class="kac-tab" title="Settings: mention-watcher ignore list, sound, and webhook options.">⚙</button>
          <button id="kac-clear" title="Clear the list shown in the current tab (Log or Mentions).">Clear</button>
        </div>
        <div id="kac-log"
          title="Activity log: timestamped record of sends, start/stop, and any errors (e.g. 'Chat input not found'). Keeps the last ~40 lines. Toggle it with the arrow in the title bar."></div>
        <div id="kac-mentions" style="display:none"
          title="Live @mentions and replies to your username, captured from chat. Read-only — the script never replies. Enable it with 'Watch for @mentions' in the controls."></div>
        <div id="kac-settings" style="display:none">
          <div class="kac-set-h">MENTION WATCHER</div>
          <div class="kac-row">
            <label title="Usernames the watcher will skip, separated by commas. Their messages never count as mentions — mainly for chat bots (e.g. the points bot that replies to !claim and would otherwise ping you every time). The @ is optional and matching ignores capitalisation. Add or remove any names you like.">Ignore senders (comma-separated) <span class="kac-q">?</span></label>
            <input type="text" id="kac-watch-ignore" placeholder="e.g. Botrix, StreamElements"
              title="Comma-separated usernames to ignore. Messages from these senders are never logged as mentions. The @ is optional; matching is case-insensitive. Leave empty to catch everyone." />
          </div>
          <label class="kac-check"
            title="Play a short beep when a new mention arrives.">
            <input type="checkbox" id="kac-watch-sound" /> Sound on mention</label>
          <label class="kac-check"
            title="OFF (default): only @yourname and replies to you count. ON: any message containing your bare username with no @ also counts. Great for a distinctive username, noisy if your name is a short or common word.">
            <input type="checkbox" id="kac-watch-bare" /> Also match my name without @</label>
          <div class="kac-div"></div>
          <div class="kac-set-h">WEBHOOK</div>
          <label class="kac-check"
            title="POST every detected mention to a webhook (Discord, or any endpoint that accepts JSON) with the sender, the message, the channel and a timestamp. Only mentions are sent — never your own chat messages.">
            <input type="checkbox" id="kac-wh-en" /> Forward mentions to a webhook</label>
          <div class="kac-row" id="kac-wh-wrap">
            <label title="Paste your webhook URL. For Discord: Server Settings > Integrations > Webhooks > Copy Webhook URL. It is stored only in this browser.">Webhook URL <span class="kac-q">?</span></label>
            <input type="text" id="kac-wh-url" placeholder="https://discord.com/api/webhooks/..."
              title="Your webhook URL. Stored locally in this browser only. Treat it like a password — anyone with it can post to that channel." />
            <div class="kac-grid" style="margin-top:6px">
              <div class="kac-row">
                <label title="Discord = a formatted message in the channel. Generic JSON = a raw JSON body with sender/message/channel/isReply/ts fields for your own endpoint.">Format <span class="kac-q">?</span></label>
                <select id="kac-wh-fmt" title="Discord posts a readable message. Generic JSON posts raw fields for custom endpoints.">
                  <option value="discord">Discord</option>
                  <option value="json">Generic JSON</option>
                </select>
              </div>
              <div class="kac-row">
                <label title="Send a sample mention now to check the webhook works.">Check it <span class="kac-q">?</span></label>
                <button class="kac-btn" id="kac-wh-test"
                  title="Posts a test mention to the webhook right now. Watch the Log tab for the result.">Test</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(p);

    ui = {
      panel: p,
      main: p.querySelector('#kac-main'),
      drawer: p.querySelector('#kac-drawer'),
      logtab: p.querySelector('#kac-logtab'),
      logtabBadge: p.querySelector('#kac-logtab-badge'),
      head: p.querySelector('#kac-head'),
      titleEl: p.querySelector('#kac-title'),
      dot: p.querySelector('#kac-dot'),
      collapse: p.querySelector('#kac-collapse'),
      body: p.querySelector('#kac-body'),
      target: p.querySelector('#kac-target'),
      msg: p.querySelector('#kac-msg'),
      rand: p.querySelector('#kac-rand'),
      intMaxCell: p.querySelector('#kac-int-max-cell'),
      coolMaxCell: p.querySelector('#kac-cool-max-cell'),
      intM: p.querySelector('#kac-int-m'),
      intS: p.querySelector('#kac-int-s'),
      intMaxM: p.querySelector('#kac-int-max-m'),
      intMaxS: p.querySelector('#kac-int-max-s'),
      coolM: p.querySelector('#kac-cool-m'),
      coolS: p.querySelector('#kac-cool-s'),
      coolMaxM: p.querySelector('#kac-cool-max-m'),
      coolMaxS: p.querySelector('#kac-cool-max-s'),
      intRead: p.querySelector('#kac-int-read'),
      coolRead: p.querySelector('#kac-cool-read'),
      intLbl: p.querySelector('#kac-int-lbl'),
      coolLbl: p.querySelector('#kac-cool-lbl'),
      dup: p.querySelector('#kac-dup'),
      rotate: p.querySelector('#kac-rotate'),
      rotateRow: p.querySelector('#kac-rotate-row'),
      secEn: p.querySelector('#kac-sec-en'),
      secWrap: p.querySelector('#kac-sec-wrap'),
      secMsg: p.querySelector('#kac-sec-msg'),
      secVal: p.querySelector('#kac-sec-val'),
      secUnit: p.querySelector('#kac-sec-unit'),
      secStatus: p.querySelector('#kac-sec-status'),
      watchBtn: p.querySelector('#kac-watch-btn'),
      watchStatus: p.querySelector('#kac-watch-status'),
      watchUser: p.querySelector('#kac-watch-user'),
      watchIgnore: p.querySelector('#kac-watch-ignore'),
      watchSound: p.querySelector('#kac-watch-sound'),
      watchBare: p.querySelector('#kac-watch-bare'),
      whEn: p.querySelector('#kac-wh-en'),
      whWrap: p.querySelector('#kac-wh-wrap'),
      whUrl: p.querySelector('#kac-wh-url'),
      whFmt: p.querySelector('#kac-wh-fmt'),
      whTest: p.querySelector('#kac-wh-test'),
      tabLog: p.querySelector('#kac-tab-log'),
      tabMen: p.querySelector('#kac-tab-men'),
      tabSet: p.querySelector('#kac-tab-set'),
      settingsPane: p.querySelector('#kac-settings'),
      clear: p.querySelector('#kac-clear'),
      menBadge: p.querySelector('#kac-men-badge'),
      mentions: p.querySelector('#kac-mentions'),
      toggle: p.querySelector('#kac-toggle'),
      now: p.querySelector('#kac-now'),
      status: p.querySelector('#kac-status'),
      explain: p.querySelector('#kac-explain'),
      explainHead: p.querySelector('#kac-explain-head'),
      explainBody: p.querySelector('#kac-explain-body'),
      explainArrow: p.querySelector('#kac-explain-arrow'),
      exportBtn: p.querySelector('#kac-export'),
      importBtn: p.querySelector('#kac-import'),
      importFile: p.querySelector('#kac-import-file'),
      log: p.querySelector('#kac-log'),
      resize: p.querySelector('#kac-resize'),
    };

    // Show the running version in the footer.
    const verEl = p.querySelector('#kac-ver');
    if (verEl) verEl.textContent = VERSION;

    applySettingsToUI();
    setTab('log');

    // Wire events
    ui.target.addEventListener('input', () => {
      settings.targetChannel = ui.target.value;
      saveSettings();
      updateStatus();
    });
    ui.msg.addEventListener('input', () => { settings.message = ui.msg.value; saveSettings(); });
    bindMMSS(ui.intM, ui.intS, 'intervalSec', 1);
    bindMMSS(ui.intMaxM, ui.intMaxS, 'intervalMaxSec', 1);
    bindMMSS(ui.coolM, ui.coolS, 'cooldownSec', 0);
    bindMMSS(ui.coolMaxM, ui.coolMaxS, 'cooldownMaxSec', 0);
    ui.rand.addEventListener('change', () => {
      settings.randomize = ui.rand.checked;
      ui.intMaxCell.classList.toggle('hidden', !settings.randomize);
      ui.coolMaxCell.classList.toggle('hidden', !settings.randomize);
      updateRandLabels();
      updateTimingReadouts();
      saveSettings();
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
    ui.secEn.addEventListener('change', () => {
      settings.secondEnabled = ui.secEn.checked;
      ui.secWrap.classList.toggle('hidden', !settings.secondEnabled);
      saveSettings();
      if (settings.running) scheduleSecond();
      updateStatus();
    });
    ui.secMsg.addEventListener('input', () => { settings.secondMessage = ui.secMsg.value; saveSettings(); updateStatus(); });
    ui.secVal.addEventListener('input', () => {
      settings.secondValue = Math.max(1, parseInt(ui.secVal.value, 10) || 1); saveSettings();
      if (settings.running) scheduleSecond();
      updateStatus();
    });
    ui.secUnit.addEventListener('change', () => {
      settings.secondUnit = ui.secUnit.value; saveSettings();
      if (settings.running) scheduleSecond();
      updateStatus();
    });
    ui.watchBtn.addEventListener('click', () => {
      if (!settings.watchEnabled && !watchName()) {
        ui.watchStatus.textContent = 'Enter your username first';
        ui.watchUser.focus();
        return;
      }
      settings.watchEnabled = !settings.watchEnabled;
      saveSettings();
      applyWatcher();
      syncWatchControls();
    });
    ui.watchUser.addEventListener('input', () => {
      settings.watchUsername = ui.watchUser.value;
      saveSettings();
      // Matching reads the name live; just start the observer if it wasn't
      // running yet (e.g. the field was empty before), or stop it if cleared.
      applyWatcher();
      syncWatchControls();
    });
    ui.watchIgnore.addEventListener('input', () => {
      settings.ignoreSenders = ui.watchIgnore.value;
      saveSettings(); // list is read live on each match, so nothing to restart
    });
    ui.watchSound.addEventListener('change', () => { settings.watchSound = ui.watchSound.checked; saveSettings(); });
    ui.watchBare.addEventListener('change', () => {
      settings.watchBareName = ui.watchBare.checked;
      saveSettings(); // matching reads this live — nothing to restart
    });
    ui.whEn.addEventListener('change', () => {
      settings.webhookEnabled = ui.whEn.checked;
      ui.whWrap.classList.toggle('hidden', !settings.webhookEnabled);
      saveSettings();
    });
    ui.whUrl.addEventListener('input', () => { settings.webhookUrl = ui.whUrl.value; saveSettings(); });
    ui.whFmt.addEventListener('change', () => { settings.webhookFormat = ui.whFmt.value; saveSettings(); });
    ui.whTest.addEventListener('click', () => {
      if (!(settings.webhookUrl || '').trim()) { log('Webhook: paste a URL first.', true); return; }
      setTab('log'); // the result lands in the log — show it
      log('Webhook: sending test…');
      const wasEnabled = settings.webhookEnabled;
      settings.webhookEnabled = true; // let Test work even before enabling
      postWebhook({
        channel: currentChannel() || 'iceposeidon',
        sender: 'test_user',
        message: `test mention for @${watchName() || 'you'} from Kick Auto-Chat`,
        isReply: false,
        text: `test_user: test mention for @${watchName() || 'you'}`,
        ts: new Date().toISOString(),
        tsLocal: new Date().toLocaleString(),
      });
      settings.webhookEnabled = wasEnabled;
    });
    ui.tabLog.addEventListener('click', () => setTab('log'));
    ui.tabMen.addEventListener('click', () => setTab('men'));
    ui.tabSet.addEventListener('click', () => setTab('set'));
    ui.clear.addEventListener('click', () => {
      if (activeTab === 'men') {
        // Only the display is cleared — the seen-set stays, otherwise the next
        // scan would re-alert every mention still on screen and refill the list.
        ui.mentions.textContent = '';
        menTotal = 0;
        unreadMen = 0;
        updateMenBadge();
        updateWatchStatus();
      } else {
        ui.log.textContent = '';
      }
    });
    ui.explainHead.addEventListener('click', () => {
      settings.explainOpen = !settings.explainOpen;
      applyExplain();
      saveSettings();
    });
    ui.exportBtn.addEventListener('click', exportSettings);
    ui.importBtn.addEventListener('click', () => ui.importFile.click());
    ui.importFile.addEventListener('change', () => {
      const f = ui.importFile.files && ui.importFile.files[0];
      if (f) importSettingsFile(f);
      ui.importFile.value = ''; // let the same file be picked again
    });
    ui.toggle.addEventListener('click', () => settings.running ? stop() : start());
    ui.now.addEventListener('click', sendNow);
    ui.logtab.addEventListener('click', () => {
      settings.logOpen = !settings.logOpen;
      applyDrawer();
      if (settings.logOpen) clampOnScreen();
      saveSettings();
    });
    ui.collapse.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      ui.body.classList.toggle('hidden', settings.collapsed);
      applySize();
      applyDrawer();
      updateStatus();
      saveSettings();
    });

    makeDraggable(p, ui.head);
    makeResizable();
    syncControls();
    updateStatus();
    if (settings.logOpen && !settings.collapsed) clampOnScreen();
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

  // Push every value in `settings` into the controls. Used on first build and
  // again after restoring a backup, so there's one place that maps state -> UI.
  function applySettingsToUI() {
    ui.target.value = settings.targetChannel;
    ui.msg.value = settings.message;
    writeMMSS(ui.intM, ui.intS, settings.intervalSec);
    writeMMSS(ui.intMaxM, ui.intMaxS, settings.intervalMaxSec);
    writeMMSS(ui.coolM, ui.coolS, settings.cooldownSec);
    writeMMSS(ui.coolMaxM, ui.coolMaxS, settings.cooldownMaxSec);
    ui.rand.checked = settings.randomize;
    ui.intMaxCell.classList.toggle('hidden', !settings.randomize);
    ui.coolMaxCell.classList.toggle('hidden', !settings.randomize);
    updateRandLabels();
    updateTimingReadouts();
    ui.dup.checked = settings.antiDup;
    ui.rotate.value = settings.rotateKeywords;
    ui.rotateRow.classList.toggle('hidden', !settings.antiDup);
    ui.secEn.checked = settings.secondEnabled;
    ui.secMsg.value = settings.secondMessage;
    ui.secVal.value = settings.secondValue;
    ui.secUnit.value = settings.secondUnit;
    ui.secWrap.classList.toggle('hidden', !settings.secondEnabled);
    ui.watchUser.value = settings.watchUsername;
    ui.watchIgnore.value = settings.ignoreSenders;
    ui.watchSound.checked = settings.watchSound;
    ui.watchBare.checked = settings.watchBareName;
    ui.whEn.checked = settings.webhookEnabled;
    ui.whUrl.value = settings.webhookUrl;
    ui.whFmt.value = settings.webhookFormat;
    ui.whWrap.classList.toggle('hidden', !settings.webhookEnabled);
    syncWatchControls();
    updateMenBadge();
    updateExplain();
    applyExplain();
    if (settings.pos.left != null) {
      ui.panel.style.left = settings.pos.left + 'px';
      ui.panel.style.top = settings.pos.top + 'px';
      ui.panel.style.right = 'auto';
    }
    ui.body.classList.toggle('hidden', settings.collapsed);
    applySize();
    applyDrawer();
  }

  // Apply the saved size to the controls column. Height is only applied when
  // expanded — collapsed the column hugs the header. The log drawer stretches to
  // match the column's height automatically (flex align-stretch).
  function applySize() {
    const m = ui.main;
    m.style.width = settings.size.w ? settings.size.w + 'px' : '';
    m.style.height = (settings.size.h && !settings.collapsed) ? settings.size.h + 'px' : '';
    // The resize grip only makes sense when expanded — hide it when collapsed
    // so it can't be dragged into blank space.
    if (ui.resize) ui.resize.style.display = settings.collapsed ? 'none' : '';
  }

  // Show/hide the log drawer (hidden when collapsed regardless of logOpen).
  function applyDrawer() {
    const open = settings.logOpen && !settings.collapsed;
    ui.drawer.style.display = open ? 'flex' : 'none';
    ui.logtab.textContent = open ? '◀' : '▶';
    ui.logtab.style.display = settings.collapsed ? 'none' : '';
  }

  // Keep the (possibly wider) panel on screen — used after opening the drawer.
  function clampOnScreen() {
    const r = ui.panel.getBoundingClientRect();
    let left = r.left, top = r.top;
    if (r.right > window.innerWidth - 4) left = window.innerWidth - r.width - 4;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    ui.panel.style.left = Math.round(left) + 'px';
    ui.panel.style.top = Math.round(top) + 'px';
    ui.panel.style.right = 'auto';
    settings.pos = { left: Math.round(left), top: Math.round(top) };
  }

  // Resize the controls column via the corner grip. The panel is anchored by
  // left/top first so it grows toward the bottom-right; the drawer follows.
  function makeResizable() {
    const handle = ui.resize, main = ui.main, panel = ui.panel;
    let rz = false, sx = 0, sy = 0, sw = 0, sh = 0;
    handle.addEventListener('mousedown', (e) => {
      rz = true;
      const pr = panel.getBoundingClientRect();
      panel.style.left = pr.left + 'px';
      panel.style.top = pr.top + 'px';
      panel.style.right = 'auto';
      const mr = main.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = mr.width; sh = mr.height;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!rz) return;
      let w = Math.round(sw + (e.clientX - sx));
      let h = Math.round(sh + (e.clientY - sy));
      w = Math.max(210, Math.min(680, w));
      h = Math.max(170, Math.min(Math.round(window.innerHeight * 0.92), h));
      main.style.width = w + 'px';
      main.style.height = h + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!rz) return;
      rz = false;
      const mr = main.getBoundingClientRect();
      settings.size = { w: Math.round(mr.width), h: Math.round(mr.height) };
      const pr = panel.getBoundingClientRect();
      settings.pos = { left: Math.round(pr.left), top: Math.round(pr.top) };
      saveSettings();
    });
  }

  // The coloured group titles carry the Interval/Cooldown names, so the inner
  // labels only need to say whether the row is a range Min or a fixed value.
  function updateRandLabels() {
    if (ui.intLbl) ui.intLbl.textContent = settings.randomize ? 'Min' : 'Every';
    if (ui.coolLbl) ui.coolLbl.textContent = settings.randomize ? 'Min' : 'Gap';
  }

  // ---- minutes+seconds fields --------------------------------------------
  // Settings still store TOTAL SECONDS; the m/s boxes are just a friendlier
  // way to read and edit that number, so old saved settings/backups still work.
  function fmtMS(total) {
    const t = Math.max(0, Math.floor(total || 0));
    const m = Math.floor(t / 60), s = t % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function readMMSS(mEl, sEl) {
    const m = Math.max(0, parseInt(mEl.value, 10) || 0);
    const s = Math.max(0, parseInt(sEl.value, 10) || 0);
    return m * 60 + s; // the two boxes simply add together
  }

  function writeMMSS(mEl, sEl, total) {
    const t = Math.max(0, Math.floor(total || 0));
    mEl.value = Math.floor(t / 60);
    sEl.value = t % 60;
  }

  // Wire a minutes+seconds pair to a settings key holding total seconds.
  function bindMMSS(mEl, sEl, key, minTotal) {
    const apply = () => {
      settings[key] = Math.max(minTotal, readMMSS(mEl, sEl));
      saveSettings();
      if (settings.running) scheduleNext();
      updateTimingReadouts();
    };
    mEl.addEventListener('input', apply);
    sEl.addEventListener('input', apply);
    // On blur, re-render from the stored total so e.g. 90s becomes 1m 30s.
    const normalise = () => writeMMSS(mEl, sEl, settings[key]);
    mEl.addEventListener('change', normalise);
    sEl.addEventListener('change', normalise);
  }

  // The "so we know the GUI understands it" readouts above each group.
  function updateTimingReadouts() {
    const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
    if (ui.intRead) {
      const a = lo(settings.intervalSec, settings.intervalMaxSec);
      const b = hi(settings.intervalSec, settings.intervalMaxSec);
      ui.intRead.textContent = settings.randomize
        ? `= sends every ${fmtMS(a)} – ${fmtMS(b)}  (${a}–${b}s)`
        : `= sends every ${fmtMS(settings.intervalSec)}  (${settings.intervalSec}s)`;
    }
    if (ui.coolRead) {
      const a = lo(settings.cooldownSec, settings.cooldownMaxSec);
      const b = hi(settings.cooldownSec, settings.cooldownMaxSec);
      ui.coolRead.textContent = settings.randomize
        ? `= gap of ${fmtMS(a)} – ${fmtMS(b)}  (${a}–${b}s)`
        : `= gap of ${fmtMS(settings.cooldownSec)}  (${settings.cooldownSec}s)`;
    }
  }

  function syncControls() {
    if (!ui.toggle) return;
    ui.toggle.textContent = settings.running ? 'Stop' : 'Start';
    ui.toggle.className = 'kac-btn ' + (settings.running ? 'stop' : 'start');
    ui.dot.classList.toggle('on', settings.running);
  }

  // Human-friendly countdown: "3h 59m", "4m 12s", or "9s".
  function fmtDur(ms) {
    let s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Compact form for the title bar: "3h59m", "4m12s", "9s".
  function fmtShort(ms) {
    let s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
  }

  // The scheduled-message tail shown in the title (e.g. " · !claim 3h59m").
  function secondTitleTail() {
    const msg = (settings.secondMessage || '').trim();
    if (!settings.secondEnabled || !msg) return '';
    const label = msg.length > 10 ? msg.slice(0, 10) : msg;
    return ` · ${label} ${fmtShort(secondNextSendAt - Date.now())}`;
  }

  function updateSecondStatus() {
    if (!ui.secStatus) return;
    const msg = (settings.secondMessage || '').trim();
    if (!settings.secondEnabled || !msg) { ui.secStatus.textContent = ''; return; }
    if (settings.running) {
      ui.secStatus.innerHTML = `Next <b>${msg}</b> in <b>${fmtDur(secondNextSendAt - Date.now())}</b> · sent ${secondCount}`;
    } else {
      ui.secStatus.innerHTML = `Idle · every ${settings.secondValue} ${settings.secondUnit}`;
    }
  }

  function updateStatus() {
    if (!ui.status) return;
    updateSecondStatus();
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
      ui.status.innerHTML = `Running on <b>@${target}</b> — next in <b>${secs}s</b> · sent ${sendCount}${settings.randomize ? ' · rand' : ''}`;
      // Mirror into the title bar so it's visible even when collapsed, including
      // the scheduled-message countdown (e.g. !claim 3h59m).
      const tail = secondTitleTail();
      ui.titleEl.textContent = settings.collapsed
        ? `${secs}s · ${sendCount} sent${tail}`
        : `Kick Auto-Chat · ${secs}s · ${sendCount} sent${tail}`;
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
  // Mention watcher — reads the on-page chat (DOM) for @mentions and replies
  // to your own username and logs them to the Mentions tab. Read-only; it
  // never sends anything.
  // ----------------------------------------------------------------------
  function setTab(tab) {
    activeTab = tab;
    if (ui.log) ui.log.style.display = tab === 'log' ? '' : 'none';
    if (ui.mentions) ui.mentions.style.display = tab === 'men' ? '' : 'none';
    if (ui.settingsPane) ui.settingsPane.style.display = tab === 'set' ? '' : 'none';
    if (ui.tabLog) ui.tabLog.classList.toggle('active', tab === 'log');
    if (ui.tabMen) ui.tabMen.classList.toggle('active', tab === 'men');
    if (ui.tabSet) ui.tabSet.classList.toggle('active', tab === 'set');
    // Clear only applies to the two list tabs.
    if (ui.clear) ui.clear.style.display = tab === 'set' ? 'none' : '';
    if (tab === 'men') { unreadMen = 0; updateMenBadge(); }
  }

  function updateMenBadge() {
    const label = unreadMen > 99 ? '99+' : String(unreadMen);
    if (ui.menBadge) {
      if (unreadMen > 0) { ui.menBadge.textContent = label; ui.menBadge.style.display = ''; }
      else ui.menBadge.style.display = 'none';
    }
    // Numeric badge on the title-bar arrow, so the count is visible even when
    // the drawer is closed.
    if (ui.logtabBadge) {
      if (unreadMen > 0) { ui.logtabBadge.textContent = label; ui.logtabBadge.style.display = ''; }
      else ui.logtabBadge.style.display = 'none';
    }
    // Also tint the drawer arrow red when there are unseen mentions.
    if (ui.logtab) ui.logtab.style.color = unreadMen > 0 ? '#ff4757' : '';
  }

  function updateWatchStatus() {
    if (!ui.watchStatus) return;
    const name = watchName();
    if (!settings.watchEnabled) { ui.watchStatus.textContent = 'Not watching'; return; }
    if (!name) { ui.watchStatus.textContent = 'Enter your username to start'; return; }
    ui.watchStatus.innerHTML = `Watching <b>@${name}</b> · ${menTotal} mention${menTotal === 1 ? '' : 's'}`;
  }

  function syncWatchControls() {
    if (!ui.watchBtn) return;
    ui.watchBtn.textContent = settings.watchEnabled ? 'Stop watching' : 'Start watching';
    ui.watchBtn.classList.toggle('watching', settings.watchEnabled);
    updateWatchStatus();
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.07, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      o.start(); o.stop(ctx.currentTime + 0.26);
      o.onended = () => { try { ctx.close(); } catch (e) {} };
    } catch (e) { /* autoplay/policy — ignore */ }
  }

  // Your username, normalized: trimmed and with any leading @ removed (so it
  // works whether or not the user types the @).
  function watchName() {
    return (settings.watchUsername || '').trim().replace(/^@+/, '');
  }

  // Senders to skip (bots, etc.) — comma-separated, @ optional, case-insensitive.
  function ignoredSenders() {
    return (settings.ignoreSenders || '')
      .split(',')
      .map(s => s.trim().replace(/^@+/, '').toLowerCase())
      .filter(Boolean);
  }

  function isIgnoredSender(sender) {
    if (!sender) return false;
    const s = sender.trim().replace(/^@+/, '').toLowerCase();
    return ignoredSenders().includes(s);
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Work out whether — and HOW — a line concerns you. Matching the whole line
  // blindly is wrong: a reply's quoted text can contain your name even though the
  // sender never tagged you, which is how "baezyx mentioned you" got reported for
  // a message that was really three dolphin emotes aimed at a bot.
  //   'reply'   – they replied directly to you
  //   'mention' – they tagged you in what they actually typed
  //   'quote'   – they replied to someone ELSE's message that tagged you
  function classifyLine(el, name) {
    const esc = escapeRe(name);
    const atMe = new RegExp('@' + esc + '\\b', 'i');
    const bareMe = new RegExp('\\b' + esc + '\\b', 'i');
    const body = extractBody(el) || '';
    const rep = extractReply(el);

    if (rep && rep.user && rep.user.toLowerCase() === name.toLowerCase()) {
      return { hit: true, kind: 'reply', body, rep };
    }
    if (atMe.test(body)) return { hit: true, kind: 'mention', body, rep };
    if (settings.watchBareName && bareMe.test(body)) {
      return { hit: true, kind: 'mention', body, rep };
    }
    if (rep && rep.quote && (atMe.test(rep.quote) ||
        (settings.watchBareName && bareMe.test(rep.quote)))) {
      return { hit: true, kind: 'quote', body, rep };
    }
    return { hit: false };
  }

  // Kick renders the username as <button data-prevent-expand> and its text
  // INCLUDES a leading @ (e.g. "@ShoovyBot") — strip it so ignore-list and
  // own-message comparisons work against a bare name.
  function extractSender(node) {
    let s = '';
    try {
      const b = node.querySelector && node.querySelector('button[data-prevent-expand]');
      if (b) s = b.textContent || '';
      if (!s) {
        const alt = node.querySelector && node.querySelector('[class*="username" i], [data-chat-entry-user]');
        if (alt) s = alt.textContent || '';
      }
      if (!s) {
        const t = node.textContent || '';
        const i = t.indexOf(':');
        if (i > 0 && i < 32) s = t.slice(0, i);
      }
    } catch (e) {}
    return (s || '').replace(/\s+/g, ' ').trim().replace(/^@+/, '');
  }

  // Emotes are <span data-emote-name="x"> wrapping an <img alt="x">. They carry no
  // text, so a message that is only emotes reads as empty — render them as :name:.
  function deEmote(root) {
    root.querySelectorAll('[data-emote-name]').forEach((n) =>
      n.replaceWith(root.ownerDocument.createTextNode(' :' + n.getAttribute('data-emote-name') + ': ')));
    root.querySelectorAll('img[alt]').forEach((n) =>
      n.replaceWith(root.ownerDocument.createTextNode(' :' + n.getAttribute('alt') + ': ')));
  }

  // The message the user actually typed. Scoped to the nearest .break-words box
  // around the username button — a reply's "Replying to ..." preview is a SIBLING
  // of that box, so scoping this way excludes the quoted text automatically.
  function extractBody(el) {
    try {
      const btn = el.querySelector('button[data-prevent-expand]');
      const box = (btn && btn.closest('.break-words')) || el;
      const c = box.cloneNode(true);
      c.querySelectorAll('span[style*="chatroom-timestamps-display"]').forEach((n) => n.remove());
      c.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      c.querySelectorAll('button[data-prevent-expand]').forEach((n) => (n.parentElement || n).remove());
      deEmote(c);
      const t = (c.textContent || '').replace(/\s+/g, ' ').trim();
      return t || null;
    } catch (e) {
      return null;
    }
  }

  // The "Replying to @who: quoted text" preview, if this line is a reply.
  // It's a <button> (without data-prevent-expand) whose text starts "Replying to".
  function extractReply(el) {
    try {
      const rb = [...el.querySelectorAll('button')].find(
        (b) => !b.hasAttribute('data-prevent-expand') &&
               /^\s*Replying to/i.test((b.textContent || '').replace(/\s+/g, ' ')));
      if (!rb) return null;
      const wrap = rb.querySelector('span');
      const kids = wrap ? [...wrap.querySelectorAll(':scope > span')] : [];
      const userEl = kids[0], quoteEl = kids[1];
      const quoteClone = quoteEl ? quoteEl.cloneNode(true) : null;
      if (quoteClone) deEmote(quoteClone);
      return {
        user: userEl ? (userEl.textContent || '').trim().replace(/^@+/, '') : '',
        quote: quoteClone ? (quoteClone.textContent || '').replace(/\s+/g, ' ').trim() : '',
      };
    } catch (e) {
      return null;
    }
  }

  function postWebhook(data) {
    if (!settings.webhookEnabled) return;
    const url = (settings.webhookUrl || '').trim();
    if (!url) return;

    let body;
    if (settings.webhookFormat === 'discord') {
      const who = data.sender || 'someone';
      const verb = data.kind === 'reply' ? 'replied to you'
        : data.kind === 'quote' ? `replied to @${data.replyTo}'s message that tagged you`
        : 'mentioned you';
      let content = `**${who}** ${verb} in kick.com/${data.channel} — ${data.tsLocal}\n> ${data.message}`;
      // For a quote match, include what was quoted — that's where your name was.
      if (data.kind === 'quote' && data.replyQuote) {
        content += `\n(in reply to: ${data.replyQuote.slice(0, 200)})`;
      }
      body = JSON.stringify({
        username: 'Kick Auto-Chat',
        content,
        // Never let a chat message trigger @everyone/@here pings in Discord.
        allowed_mentions: { parse: [] },
      });
    } else {
      body = JSON.stringify({ source: 'kick-autochat', ...data });
    }

    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then((r) => { if (!r.ok) log(`Webhook failed: HTTP ${r.status}`, true); })
      .catch((e) => log(`Webhook error: ${e.message} (blocked by CORS?)`, true));
  }

  function addMention(m) {
    if (!ui.mentions) return;
    const now = new Date();
    const time = now.toLocaleTimeString(); // local clock
    const body = m.body || '(no text)';
    const prefix = m.kind === 'reply' ? '↩ ' : m.kind === 'quote' ? '❝ ' : '';
    const reUser = m.kind === 'quote' && m.rep && m.rep.user ? ` (re: @${m.rep.user})` : '';

    const div = document.createElement('div');
    div.className = 'kac-men-item ' + m.kind;
    // Built from separate spans with textContent, so chat text can't inject markup.
    const tEl = document.createElement('span');
    tEl.className = 'kac-men-t';
    tEl.textContent = `[${time}] `;
    div.appendChild(tEl);
    const sEl = document.createElement('span');
    sEl.className = 'kac-men-s';
    sEl.textContent = `${prefix}${m.sender || '?'}${reUser}: `;
    div.appendChild(sEl);
    const bEl = document.createElement('span');
    bEl.textContent = body;
    div.appendChild(bEl);
    // For a quote match, show what was quoted — that's where your name was.
    if (m.kind === 'quote' && m.rep && m.rep.quote) {
      const qEl = document.createElement('div');
      qEl.className = 'kac-men-q';
      qEl.textContent = '↳ ' + m.rep.quote.slice(0, 140);
      div.appendChild(qEl);
    }
    ui.mentions.appendChild(div);
    ui.mentions.scrollTop = ui.mentions.scrollHeight;
    while (ui.mentions.childNodes.length > 60) ui.mentions.removeChild(ui.mentions.firstChild);
    menTotal++;
    updateWatchStatus();
    if (activeTab !== 'men') { unreadMen++; updateMenBadge(); }
    if (settings.watchSound) beep();
    postWebhook({
      channel: currentChannel(),
      sender: m.sender || '',
      message: body,
      kind: m.kind,                        // 'mention' | 'reply' | 'quote'
      isReply: m.kind === 'reply',
      replyTo: m.rep ? m.rep.user : '',
      replyQuote: m.rep ? m.rep.quote : '',
      ts: now.toISOString(),               // UTC, machine-readable
      tsLocal: now.toLocaleString(),       // your local date + time
    });
  }

  // Called once per new line — scanChat's seen-set already handles de-duping.
  function processChatLine(target, name) {
    const sender = extractSender(target);
    if (sender && sender.toLowerCase() === name.toLowerCase()) return; // your own message
    if (isIgnoredSender(sender)) return; // bots / muted senders

    const c = classifyLine(target, name);
    if (!c.hit) return;

    addMention({ kind: c.kind, sender, body: c.body, rep: c.rep });
  }

  // Kick renders chat as a VIRTUALISED list of div[data-index="N"] wrappers, but
  // OTHER lists on the page (sidebar channels, category rails) are virtualised the
  // same way — so a container can't be trusted by position alone. A line is only a
  // chat line if it contains a username button. That check is self-validating, so
  // we scan for the lines themselves rather than guessing at their container.
  function chatLines() {
    const out = [];
    document.querySelectorAll('div[data-index]').forEach((el) => {
      if (!el.querySelector('button[data-prevent-expand]')) return; // not chat
      const idx = parseInt(el.getAttribute('data-index'), 10);
      if (Number.isFinite(idx)) out.push({ el, idx });
    });
    out.sort((a, b) => a.idx - b.idx);
    return out;
  }

  // Identity of a chat line, independent of its position in the virtual list.
  // Kick's own timestamp is in the DOM even when hidden by CSS, which gives us
  // minute resolution to separate a repeat from a re-render of the same message.
  function lineSig(el) {
    const tEl = el.querySelector('span[style*="chatroom-timestamps-display"]');
    const t = tEl ? (tEl.textContent || '').trim() : '';
    return t + '|' + extractSender(el) + '|' + (extractBody(el) || '').slice(0, 140);
  }

  // Poll the rendered chat lines once a second. Simpler and far more robust than
  // a MutationObserver here: React re-renders can swap the list container out from
  // under an observer, and the virtualiser recycles rows. Only ~20-40 short lines
  // are on screen, so the cost is trivial.
  function scanChat() {
    if (!settings.watchEnabled) return;
    const name = watchName();
    if (!name) return;
    const lines = chatLines();
    if (!lines.length) return;

    if (!watcherSeeded) {
      // First sight of chat: mark everything on screen as already seen so the
      // backlog isn't replayed as brand-new mentions.
      for (const { el } of lines) seenLines.add(lineSig(el));
      watcherSeeded = true;
      log(`Mention watcher attached (@${name}) — ${lines.length} lines on screen.`);
      return;
    }

    for (const { el } of lines) {
      const sig = lineSig(el);
      if (seenLines.has(sig)) continue; // already handled, or just a re-render
      seenLines.add(sig);
      // Plenty of headroom over the ~40 lines on screen, so nothing still
      // visible can be evicted and re-alert.
      while (seenLines.size > 500) seenLines.delete(seenLines.values().next().value);
      processChatLine(el, name);
    }
  }

  function startWatcher() {
    if (watchTimer) return;
    watcherSeeded = false;
    seenLines.clear();
    watchTimer = setInterval(scanChat, 1000);
    scanChat();
  }

  function stopWatcher() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    watcherSeeded = false;
    seenLines.clear();
  }

  function applyWatcher() {
    if (settings.watchEnabled && watchName()) startWatcher();
    else stopWatcher();
  }

  // ----------------------------------------------------------------------
  // Backup / restore — export every setting to a JSON file and read it back.
  // ----------------------------------------------------------------------
  function exportSettings() {
    try {
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kick-autochat-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      log('Settings backed up to file.');
    } catch (e) {
      log(`Backup failed: ${e.message}`, true);
    }
  }

  function importSettingsFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('that file is not a settings backup');
        }
        // Merge over DEFAULTS so an older/partial backup can't leave holes.
        const merged = { ...DEFAULTS, ...parsed };
        if (!merged.pos || typeof merged.pos !== 'object') merged.pos = { left: null, top: null };
        if (!merged.size || typeof merged.size !== 'object') merged.size = { w: null, h: null };
        merged.running = false; // never auto-start sending straight off a restore

        stop();
        Object.keys(settings).forEach((k) => delete settings[k]);
        Object.assign(settings, merged);
        saveSettings();
        applySettingsToUI();
        applyWatcher();
        syncControls();
        updateStatus();
        log('Settings restored from file — press Start when ready.');
      } catch (e) {
        log(`Restore failed: ${e.message}`, true);
      }
    };
    reader.onerror = () => log('Restore failed: could not read that file.', true);
    reader.readAsText(file);
  }

  // ----------------------------------------------------------------------
  // "What will happen" — a plain-English summary of the current settings,
  // rebuilt on every change so the GUI explains itself in real time.
  // ----------------------------------------------------------------------
  function explainLines() {
    const lines = [];
    const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);

    // Where it will chat.
    const t = targetChannel();
    lines.push(t
      ? `Chats ONLY on kick.com/${t} — paused on every other channel/tab.`
      : `No target channel set — nothing will send.`);

    // How often.
    const iv = settings.randomize
      ? `every ${fmtMS(lo(settings.intervalSec, settings.intervalMaxSec))}–${fmtMS(hi(settings.intervalSec, settings.intervalMaxSec))} (re-rolled each time)`
      : `every ${fmtMS(settings.intervalSec)}`;
    const cd = settings.randomize
      ? `${fmtMS(lo(settings.cooldownSec, settings.cooldownMaxSec))}–${fmtMS(hi(settings.cooldownSec, settings.cooldownMaxSec))}`
      : `${fmtMS(settings.cooldownSec)}`;
    lines.push(`Sends ${iv}, and never two sends closer than ${cd} apart.`);

    // What it sends.
    const pool = rotationPool();
    if (pool.length > 1) {
      lines.push(settings.randomize
        ? `Picks at random from ${pool.length} messages, never the same one twice in a row.`
        : `Cycles in order through ${pool.length} messages, looping back to the start.`);
    } else {
      lines.push(`Always sends the same message: "${pool[0]}".`);
    }
    lines.push(settings.antiDup
      ? `Anti-duplicate ON — adds an invisible character so Kick won't reject repeats.`
      : `Anti-duplicate OFF — Kick may block identical back-to-back messages, and rotation keywords are ignored.`);

    // Scheduled message.
    const sm = (settings.secondMessage || '').trim();
    lines.push(settings.secondEnabled && sm
      ? `Also sends "${sm}" every ${settings.secondValue} ${settings.secondUnit}, exactly as typed — it wins if both are due at once.`
      : `Scheduled message OFF — nothing extra is sent.`);

    // Mention watcher.
    const wn = watchName();
    if (settings.watchEnabled && wn) {
      lines.push(`Watching chat for ${settings.watchBareName ? `@${wn} OR bare "${wn}"` : `@${wn}`} — mentions/replies go to the Mentions tab${settings.watchSound ? ' with a beep' : ' (no sound)'}.`);
      const ign = ignoredSenders();
      lines.push(ign.length
        ? `Ignoring ${ign.length} sender${ign.length === 1 ? '' : 's'}: ${ign.join(', ')}.`
        : `No ignored senders — bots that tag you will also show up.`);
      if (settings.webhookEnabled && (settings.webhookUrl || '').trim()) {
        lines.push(`Each mention is also POSTed to your ${settings.webhookFormat === 'discord' ? 'Discord' : 'JSON'} webhook (sender + message).`);
      }
    } else {
      lines.push(`Mention watcher OFF — chat is not being read.`);
    }

    // Current state.
    lines.push(settings.running
      ? `Status: RUNNING.`
      : `Status: STOPPED — press Start to begin sending.`);

    return lines;
  }

  function updateExplain() {
    if (!ui || !ui.explainBody) return;
    ui.explainBody.textContent = '';
    for (const l of explainLines()) {
      const d = document.createElement('div');
      d.textContent = '• ' + l; // textContent: user-typed messages can't inject markup
      ui.explainBody.appendChild(d);
    }
  }

  // Collapse/expand state of the summary box.
  function applyExplain() {
    if (!ui.explainBody) return;
    ui.explainBody.classList.toggle('hidden', !settings.explainOpen);
    if (ui.explainArrow) ui.explainArrow.textContent = settings.explainOpen ? '▾' : '▸';
  }

  // ----------------------------------------------------------------------
  // Boot — wait until the page body exists, then mount.
  // ----------------------------------------------------------------------
  function boot() {
    injectStyles();
    buildPanel();
    applyWatcher();
    if (settings.running) {
      // Resume after navigation/reload if it was left running.
      scheduleNext();
      scheduleSecond();
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
