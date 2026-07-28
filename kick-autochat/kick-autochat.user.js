// ==UserScript==
// @name         Kick Auto-Chat (iceposeidon)
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.37.0
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
  const TITLE = 'Kick Auto-Chat v' + VERSION;

  // Mentions are kept in their own store so they survive a reload.
  const MEN_KEY = 'kick-autochat:mentions';
  const MEN_MAX = 60;

  // Multi-tab remote coordination. The remote server has a single state slot, so
  // if every open Kick tab posted to it they would overwrite each other and the
  // phone would flip-flop between tabs. Instead we elect ONE leader tab (ideally
  // the one on the target channel) via a shared localStorage record; only the
  // leader talks to the server. See claimRemoteLeadership().
  const TAB_ID = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  const REMOTE_LEADER_KEY = 'kick-autochat:remote-leader';
  const REMOTE_LEADER_STALE_MS = 3000; // a leader record older than this is up for grabs

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
    watchScope: 'all',      // 'all' = watch every open Kick tab; 'target' = only when on the target channel
    // Senders the watcher skips (comma-separated). Pre-filled with the usual
    // Kick bots — the points bot answering !claim would otherwise ping you
    // every time. Fully editable; add whatever you like.
    ignoreSenders: 'Botrix, StreamElements, Fossabot, Nightbot',
    webhookEnabled: false,  // POST each mention to a webhook
    webhookUrl: '',         // Discord webhook URL, or any endpoint that accepts JSON
    webhookFormat: 'discord', // 'discord' | 'json'
    remoteEnabled: false,   // mirror state to / take commands from the local remote server
    remotePort: 3300,       // must match the port server.js is listening on
    chatMonitor: false,     // alert on a new $CHAT (Chat Hype Index) 24h low — only when target=shoovy AND the remote server is polling shoovy.wtf (the browser can't, no CORS)
    running: false,
    collapsed: false,
    explainOpen: true,         // "What will happen" summary expanded
    logOpen: true,             // activity-log drawer open (side-by-side) vs hidden
    pos: { left: null, top: null },
    size: { w: null, h: null }, // controls width/height in px once the user resizes
    // Additional independent senders, each with its own message + timing +
    // Start/Stop. Purely additive — the main sender and scheduled !claim above
    // are untouched. Seeded from the current main config by "+ Duplicate sender".
    // Shape per element:
    //   { id, message, randomize, intervalSec, intervalMaxSec,
    //     cooldownSec, cooldownMaxSec, antiDup, rotateKeywords, running, collapsed }
    extraSenders: [],
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
  // Extra senders may arrive from an old install (absent), a corrupt value, or a
  // restored backup with partial records — sanitise once up front so the rest of
  // the code can trust every element has the full shape.
  normalizeExtraSenders();

  // ----------------------------------------------------------------------
  // Runtime state
  // ----------------------------------------------------------------------
  let tickTimer = null;       // 1s UI/scheduler tick
  // Per-extra-sender runtime, keyed by sender id. NOT persisted (rebuilt on load):
  //   extraRuntime[id] = { nextSendAt, sendCount, dupCounter, rotateIndex, lastBase }
  const extraRuntime = {};
  // Per-extra-sender DOM refs, keyed by sender id, so status updates don't have
  // to re-query. Rebuilt by renderExtras().
  const extraCards = {};
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
  let menTotal = 0;           // how many mentions are in the list
  let mentionLog = [];        // persisted mention records (see MEN_KEY)
  let logLines = [];          // in-memory copy of the activity log, mirrored to the remote
  let remoteTimer = null;     // heartbeat to the local remote server
  let remoteOk = null;        // last sync result: true | false | null (never tried)
  let remoteLeader = true;    // is THIS tab the elected remote leader? (single tab ⇒ always true)
  let remoteLeaderChannel = null; // channel slug of the current leader when we're a standby

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
  // Explicit-randomize variant so extra senders (each with their OWN randomize
  // flag) can share the exact same picking logic without touching settings.
  function pickSecondsR(minV, maxV, randomize) {
    if (!randomize) return minV;
    const lo = Math.min(minV, maxV);
    const hi = Math.max(minV, maxV);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  function pickSeconds(minV, maxV) {
    return pickSecondsR(minV, maxV, settings.randomize);
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

  // The tick timer is shared by the main sender AND every extra sender, so both
  // the main Start and an extra's Start must be able to spin it up.
  function ensureTick() {
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }

  // -- Extra senders: scheduling & eligibility (kept as pure helpers so the
  //    timing/collision logic is unit-testable in isolation) ----------------

  // Pure: the next-send epoch for a sender given the clock and the shared
  // lastSendAt floor. Respects the sender's own interval AND its own cooldown
  // as a floor against the last successful send, exactly like the main sender.
  function computeExtraNextSendAt(now, sender, lastAt) {
    const iv = pickSecondsR(sender.intervalSec, sender.intervalMaxSec, sender.randomize);
    const cd = pickSecondsR(sender.cooldownSec, sender.cooldownMaxSec, sender.randomize);
    return Math.max(now + iv * 1000, lastAt + cd * 1000);
  }

  // Pure: is this extra sender allowed to fire right now? Running, its own timer
  // due, AND respecting the shared minimum gap off the last global send so extras
  // can never crowd the main/scheduled messages (or each other).
  function extraSenderEligible(sender, rt, now, lastAt) {
    if (!sender || !sender.running || !rt) return false;
    const gap = Math.max(sender.cooldownSec, 3) * 1000;
    return now >= rt.nextSendAt && now >= lastAt + gap;
  }

  function scheduleExtra(sender) {
    const rt = extraRuntime[sender.id];
    if (!rt) return;
    rt.nextSendAt = computeExtraNextSendAt(Date.now(), sender, lastSendAt);
  }

  // The texts THIS extra sender rotates through: its Message plus any
  // comma-separated keywords (the keywords only count when its anti-duplicate is
  // on). Mirrors the main sender's rotationPool().
  function extraRotationPool(sender) {
    let pool = [sender.message];
    if (sender.antiDup && sender.rotateKeywords) {
      const extra = sender.rotateKeywords.split(',').map(s => s.trim()).filter(Boolean);
      pool = pool.concat(extra);
    }
    pool = pool.filter(s => s && s.length > 0);
    // De-duplicate exact repeats so random selection is fair and two identical
    // entries can't cause a back-to-back repeat.
    pool = [...new Set(pool)];
    return pool.length ? pool : [sender.message];
  }

  // The extra sender's text, mirroring buildMessage(): rotate the pool (random
  // avoiding the last one, or sequential), then append the same anti-dup
  // zero-width tail — all driven by the sender's OWN runtime slot so senders
  // never share rotation position or repeat-avoidance state.
  function buildExtraText(sender) {
    const rt = extraRuntime[sender.id];
    const pool = extraRotationPool(sender);
    let base;
    if (sender.randomize && pool.length > 1) {
      // Random order, but never the same text twice in a row (more human).
      let attempts = 0;
      do {
        base = pool[Math.floor(Math.random() * pool.length)];
        attempts++;
      } while (rt && base === rt.lastBase && attempts < 12);
    } else {
      // Fixed rotation: step through the pool in order.
      const idx = rt ? rt.rotateIndex : 0;
      base = pool[idx % pool.length];
      if (rt) rt.rotateIndex = (rt.rotateIndex + 1) % pool.length;
    }
    if (rt) rt.lastBase = base;

    let msg = base;
    if (sender.antiDup && rt) {
      // Append N invisible zero-width spaces so Kick doesn't see an identical
      // consecutive message. Cycles 0..5 so it never grows unbounded.
      rt.dupCounter = (rt.dupCounter + 1) % 6;
      msg += '​'.repeat(rt.dupCounter);
    }
    return msg;
  }

  // Short label for the activity log: "#2 Cx" style (index + first ~12 chars).
  function extraShortLabel(sender) {
    const i = settings.extraSenders.indexOf(sender);
    const n = i >= 0 ? '#' + (i + 1) : '';
    const m = (sender.message || '').slice(0, 12);
    return ((n + (m ? ' ' + m : '')).trim()) || 'extra';
  }

  function sendExtra(sender) {
    const rt = extraRuntime[sender.id];
    if (!rt) return false;
    const text = buildExtraText(sender);
    // sendRaw enforces isOnTarget(), updates the global lastSendAt, and runs
    // slow-mode detection — extras go through the exact same gate as the main.
    if (!sendRaw(text)) return false;
    rt.sendCount++;
    log('Sent [' + extraShortLabel(sender) + '] "' + (sender.message || '') + '"');
    updateExtraStatus(sender);
    return true;
  }

  function updateAllExtraStatus() {
    for (const s of settings.extraSenders) updateExtraStatus(s);
  }

  function tick() {
    // Proceed if the main is running OR any extra sender is running, so an
    // extras-only session still gets serviced even with the main stopped.
    const anyActive = settings.running || settings.extraSenders.some((s) => s.running);
    if (!anyActive) return;
    const now = Date.now();
    if (!isOnTarget()) { updateStatus(); updateAllExtraStatus(); return; }

    // Minimum spacing between ANY two sends (main or scheduled), so the two
    // timers can never post closer together than the cooldown.
    const gap = Math.max(settings.cooldownSec, 3) * 1000;

    // The main + scheduled blocks only run when the main sender is running, so
    // an extras-only session doesn't fire the main message.
    if (settings.running) {
      // Priority 1: the scheduled message (e.g. !claim). It fires less often, so
      // when it's due it takes precedence. We also require the cooldown gap since
      // the last send, so it never lands right on top of a regular message.
      if (settings.secondEnabled && (settings.secondMessage || '').trim()
          && now >= secondNextSendAt && now >= lastSendAt + gap) {
        sendSecond();
        scheduleSecond();
        nextSendAt = Math.max(nextSendAt, lastSendAt + gap);
        updateStatus();
        updateAllExtraStatus();
        return; // skip everything else this tick
      }

      // Priority 2: the main rotating message (scheduleNext already enforces the
      // cooldown floor against lastSendAt).
      if (now >= nextSendAt) {
        sendMessage();
        scheduleNext();
        updateStatus();
        updateAllExtraStatus();
        return; // one send per tick
      }
    }

    // Priority 3: extra senders, in order. Only the FIRST eligible one sends this
    // tick, so N due senders naturally space out across successive ticks and the
    // one-send-per-tick invariant holds across ALL senders.
    for (const s of settings.extraSenders) {
      const rt = extraRuntime[s.id];
      if (extraSenderEligible(s, rt, now, lastSendAt)) {
        sendExtra(s);
        scheduleExtra(s);
        updateStatus();
        updateAllExtraStatus();
        return;
      }
    }

    updateStatus();
    updateAllExtraStatus();
  }

  function start() {
    if (settings.running) return;
    settings.running = true;
    saveSettings();
    // First send fires after a full interval (set to 0 below to fire immediately
    // if you prefer). We honor cooldown from the last send too.
    scheduleNext();
    scheduleSecond();
    ensureTick();
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

  // Global kill-switch: stop the main sender AND every extra (duplicate) sender.
  // Used ONLY by the remote Stop button — the panel's own main Stop stays
  // main-only, and each extra card's Stop stays that-card-only. The scheduled
  // (!claim) message follows the main, so stopping the main covers it too.
  function stopAll() {
    settings.running = false;
    for (const s of settings.extraSenders) s.running = false;
    saveSettings();
    // Refresh the main button/dot, then each extra card's Start/Stop button +
    // dot in place (no full renderExtras() rebuild, so expanded/being-edited
    // cards aren't torn down).
    syncControls();
    for (const s of settings.extraSenders) {
      updateExtraCardControls(s);
      updateExtraStatus(s);
    }
    updateStatus();
    log('Stopped all senders (remote).');
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
  // Extra senders — lifecycle (add / start / stop / send-now / remove)
  // ----------------------------------------------------------------------
  function newExtraId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function initExtraRuntime(sender) {
    extraRuntime[sender.id] = { nextSendAt: 0, sendCount: 0, dupCounter: 0, rotateIndex: 0, lastBase: null };
  }

  // Coerce one (possibly partial / restored) record into the full shape, filling
  // any missing field from the main defaults so the rest of the code can trust it.
  function normalizeExtra(s) {
    if (!s || typeof s !== 'object') return null;
    return {
      id: (typeof s.id === 'string' && s.id) ? s.id : newExtraId(),
      message: typeof s.message === 'string' ? s.message : '',
      randomize: !!s.randomize,
      intervalSec: Math.max(1, parseInt(s.intervalSec, 10) || DEFAULTS.intervalSec),
      intervalMaxSec: Math.max(1, parseInt(s.intervalMaxSec, 10) || DEFAULTS.intervalMaxSec),
      cooldownSec: Math.max(0, parseInt(s.cooldownSec, 10) || DEFAULTS.cooldownSec),
      cooldownMaxSec: Math.max(0, parseInt(s.cooldownMaxSec, 10) || DEFAULTS.cooldownMaxSec),
      antiDup: !!s.antiDup,
      rotateKeywords: typeof s.rotateKeywords === 'string' ? s.rotateKeywords : '',
      running: !!s.running,
      collapsed: !!s.collapsed,
    };
  }

  function normalizeExtraSenders() {
    if (!Array.isArray(settings.extraSenders)) { settings.extraSenders = []; return; }
    settings.extraSenders = settings.extraSenders.map(normalizeExtra).filter(Boolean);
  }

  // Create a new extra sender seeded from the CURRENT main-sender config.
  function addExtraFromMain() {
    const sender = {
      id: newExtraId(),
      message: settings.message,
      randomize: settings.randomize,
      intervalSec: settings.intervalSec,
      intervalMaxSec: settings.intervalMaxSec,
      cooldownSec: settings.cooldownSec,
      cooldownMaxSec: settings.cooldownMaxSec,
      antiDup: settings.antiDup,
      rotateKeywords: settings.rotateKeywords,
      running: false,
      collapsed: false,
    };
    settings.extraSenders.push(sender);
    initExtraRuntime(sender);
    saveSettings();
    renderExtras();
    const c = extraCards[sender.id];
    if (c && c.card && c.card.scrollIntoView) c.card.scrollIntoView({ block: 'nearest' });
  }

  function startExtra(sender) {
    sender.running = true;
    saveSettings();
    scheduleExtra(sender);
    ensureTick(); // an extra can run even if the main was never started
    updateExtraCardControls(sender);
    updateExtraStatus(sender);
    log('Started [' + extraShortLabel(sender) + '].');
  }

  function stopExtra(sender) {
    sender.running = false;
    saveSettings();
    updateExtraCardControls(sender);
    updateExtraStatus(sender);
    log('Stopped [' + extraShortLabel(sender) + '].');
  }

  function sendNowExtra(sender) {
    if (!isOnTarget()) {
      log(`Blocked — not on @${targetChannel() || '(unset)'} (here: @${currentChannel() || '—'})`, true);
      return;
    }
    sendExtra(sender);
    if (sender.running) scheduleExtra(sender);
  }

  function removeExtra(sender) {
    sender.running = false; // ensure the tick stops servicing it immediately
    const idx = settings.extraSenders.indexOf(sender);
    if (idx >= 0) settings.extraSenders.splice(idx, 1);
    delete extraRuntime[sender.id];
    saveSettings();
    renderExtras();
    log('Removed an extra sender.');
  }

  // ----------------------------------------------------------------------
  // GUI
  // ----------------------------------------------------------------------
  let ui = {};

  function injectStyles() {
    const css = `
      /* Cap to the viewport so accumulating log/mention lines scroll INSIDE the
         panel instead of stretching this fixed-position panel off the screen. */
      #kac-panel{position:fixed;z-index:2147483647;top:90px;right:16px;
        display:flex;flex-direction:row;align-items:stretch;gap:8px;
        max-height:calc(100vh - 24px);
        color:#e7e7ea;font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;user-select:none}
      #kac-main{position:relative;display:flex;flex-direction:column;width:248px;min-width:210px;min-height:0;
        background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden}
      #kac-drawer{display:flex;flex-direction:column;width:300px;min-width:170px;min-height:0;align-self:stretch;
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
      /* The scroll panes are absolutely positioned inside this filler, so their
         content does NOT count toward the drawer's height. That makes the main
         controls column the sole height determinant: the drawer matches it and
         grows with it on resize, and each pane scrolls internally. */
      #kac-drawer-body{position:relative;flex:1 1 0;min-height:0}
      #kac-mentions{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;padding:6px;font-size:10.5px;background:#0a0a0d}
      #kac-tab-set{flex:0 0 32px}
      #kac-settings{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;padding:8px;
        display:flex;flex-direction:column;gap:8px;background:#0f0f12}
      .kac-set-h{font-size:9.5px;font-weight:700;letter-spacing:.4px;color:#9a9aa3}
      .kac-men-item{color:#e7e7ea;padding:3px 4px;border-bottom:1px solid #16161b;word-break:break-word}
      .kac-men-item.reply{border-left:2px solid #9ad4ff;padding-left:4px}
      .kac-men-item.quote{border-left:2px solid #ffc266;padding-left:4px}
      .kac-men-t{color:#6f6f78}
      .kac-men-c{color:#7a8;font-size:9.5px}
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
      /* Side by side when there's width, stacking automatically when there isn't. */
      .kac-groups{display:flex;gap:8px;flex-wrap:wrap}
      .kac-groups .kac-group{flex:1 1 250px;min-width:0}
      .kac-group{border-radius:8px;padding:5px 6px;border:1px solid}
      .kac-g-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:3px}
      .kac-g-title{flex:0 0 auto;font-size:9px;font-weight:700;letter-spacing:.4px;white-space:nowrap}
      .kac-g-read{font-size:9px;font-weight:600;cursor:help;min-width:0;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .kac-g-int{background:rgba(83,252,24,.06);border-color:rgba(83,252,24,.30)}
      .kac-g-int .kac-g-title{color:#7ee85a}
      .kac-g-int .kac-g-read{color:#bdf5a8}
      .kac-g-cool{background:rgba(120,160,255,.07);border-color:rgba(120,160,255,.32)}
      .kac-g-cool .kac-g-title{color:#93b4ff}
      .kac-g-cool .kac-g-read{color:#c3d6ff}
      .kac-mmss{display:flex;align-items:center;gap:3px}
      /* display:contents keeps the inputs as flex items of the row while still
         letting the whole max half hide as one unit. */
      .kac-mm-max{display:contents}
      .kac-mm-max.hidden{display:none}
      /* Capped so a wide panel doesn't turn these into giant boxes. */
      .kac-mmss input[type=number]{flex:0 1 56px;max-width:56px;min-width:0;box-sizing:border-box;
        background:#17171c;border:1px solid #2a2a30;color:#e7e7ea;border-radius:5px;
        padding:4px 2px;font:inherit;font-size:11px;text-align:center;
        appearance:textfield;-moz-appearance:textfield}
      .kac-mmss input[type=number]::-webkit-inner-spin-button,
      .kac-mmss input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
      .kac-u{flex:0 0 auto;font-size:9px;color:#9a9aa3}
      .kac-arrow{flex:0 0 auto;font-size:10px;color:#9a9aa3}
      .kac-inat{display:flex;align-items:center;gap:2px;background:#17171c;border:1px solid #2a2a30;border-radius:6px;padding-left:8px}
      .kac-inat span{color:#9a9aa3;font-weight:700;font-size:12px}
      .kac-inat input[type=text]{border:none;background:transparent;flex:1 1 auto;width:auto;padding-left:2px}
      #kac-sec-status{font-size:11px;color:#9a9aa3;min-height:14px;cursor:help}
      #kac-sec-status b{color:#53fc18}
      #kac-rem-status{font-size:10px;color:#9a9aa3;min-height:13px;margin-top:5px;cursor:help;word-break:break-word}
      #kac-rem-status b{color:#53fc18}
      .kac-grid{display:flex;gap:8px}
      .kac-grid .kac-row{flex:1}
      .kac-check{display:flex;align-items:center;gap:6px;color:#cfcfd6;cursor:pointer}
      .kac-checks{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
      .kac-checks .kac-check{flex:0 1 auto}
      .kac-inline{display:flex;align-items:center;gap:6px}
      .kac-inline .kac-inat{flex:1 1 auto;min-width:0;max-width:240px}
      .kac-inline-lbl{flex:0 0 auto;display:flex;align-items:center;gap:4px;
        color:#9a9aa3;font-size:11px;cursor:help;white-space:nowrap}
      .kac-btns{display:flex;gap:8px;margin-top:2px}
      /* flex:1 only makes sense inside .kac-btns (a row). A .kac-btn placed
         directly in the body (a COLUMN) would grow to fill all leftover height. */
      .kac-btns .kac-btn{flex:1}
      .kac-btn{flex:0 0 auto;border:none;border-radius:7px;padding:8px;font:inherit;font-weight:700;cursor:pointer}
      .kac-btn-w{flex:0 0 auto;width:118px;padding:7px 8px;font-size:11px}
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
      #kac-log{position:absolute;inset:0;font-size:10.5px;color:#7d7d85;background:#0a0a0d;
        padding:6px;overflow-y:auto;overflow-x:hidden;
        white-space:pre-wrap;word-break:break-word}
      #kac-log .err{color:#ff7b7b}
      #kac-explain{font-size:10px;line-height:1.45;border-radius:8px;padding:6px 7px;
        background:rgba(255,184,77,.07);border:1px solid rgba(255,184,77,.30)}
      #kac-explain-head{display:flex;align-items:center;justify-content:space-between;gap:6px;
        color:#ffc266;font-weight:700;font-size:9.5px;letter-spacing:.4px;cursor:pointer;user-select:none}
      #kac-explain-body{margin-top:4px;color:#cbb894}
      #kac-explain-body.hidden{display:none}
      #kac-explain-body div{padding:1px 0}
      #kac-resize{position:absolute;right:2px;bottom:2px;width:15px;height:15px;cursor:nwse-resize;
        background:
          linear-gradient(135deg,transparent 0 48%,#5a5a63 48% 56%,transparent 56% 70%,#5a5a63 70% 78%,transparent 78%);
        border-bottom-right-radius:8px;opacity:.8}
      #kac-resize:hover{opacity:1}
      /* Extra senders */
      #kac-extras{display:flex;flex-direction:column;gap:6px}
      #kac-extras:empty{display:none}
      #kac-extra-add{margin-top:2px}
      .kac-ex-card{border:1px solid #2a2a30;border-radius:8px;background:#121218;overflow:hidden}
      .kac-ex-head{display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:pointer;background:#15151b}
      .kac-ex-dot{width:7px;height:7px;border-radius:50%;background:#666;flex:0 0 auto}
      .kac-ex-dot.on{background:#53fc18;box-shadow:0 0 6px #53fc18}
      .kac-ex-prev{flex:0 1 auto;font-weight:700;color:#e7e7ea;min-width:0;max-width:96px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .kac-ex-mini{flex:1 1 auto;min-width:0;font-size:9.5px;color:#9a9aa3;text-align:right;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .kac-ex-mini b{color:#53fc18}
      .kac-ex-caret{flex:0 0 auto;color:#9a9aa3;font-size:11px}
      .kac-ex-rm{flex:0 0 auto;background:none;border:none;color:#9a9aa3;font-size:15px;
        line-height:1;cursor:pointer;padding:0 2px}
      .kac-ex-rm:hover{color:#ff4757}
      .kac-ex-body{padding:6px;display:flex;flex-direction:column;gap:6px;border-top:1px solid #2a2a30}
      .kac-ex-body.hidden{display:none}
      .kac-ex-go{background:#53fc18;color:#0a0a0a}
      .kac-ex-stop{background:#ff4757;color:#fff}
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
        <span id="kac-title">Kick Auto-Chat</span><!-- replaced with TITLE (incl. version) on build -->
        <button id="kac-logtab" title="Show / hide the log & mentions panel on the right.">◀</button>
        <span id="kac-logtab-badge" class="kac-badge" title="Unseen mentions — open the panel and click the Mentions tab to view them.">0</span>
        <button id="kac-collapse" title="Collapse / expand the panel. State is remembered.">_</button>
      </div>
      <div id="kac-body">
        <div class="kac-grid">
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
        </div>
        <div class="kac-checks">
          <label class="kac-check"
            title="Randomize timing &amp; keyword order. When on: (1) each send waits a RANDOM whole number of seconds between the Min and Max of each coloured group below, re-rolled every cycle; and (2) rotation keywords are sent in RANDOM order, never the same one twice in a row. Makes the bot look less robotic.">
            <input type="checkbox" id="kac-rand" /> Randomize</label>
          <label class="kac-check"
            title="Kick rejects an identical message sent twice in a row ('you already sent this message'). When on, the script appends 0-5 invisible zero-width characters that cycle each send, so repeated text like Cx still posts, and the rotation keywords field becomes active. Recommended ON.">
            <input type="checkbox" id="kac-dup" /> Anti-duplicate</label>
          <label class="kac-check"
            title="A SECOND message on its own long timer (e.g. a bot command like !claim every 4 hours), running alongside the main spammer. When both are due at the same moment, this one takes priority and the main message is held back by the cooldown. Sent EXACTLY as typed (no rotation, no anti-duplicate char) so commands are recognized.">
            <input type="checkbox" id="kac-sec-en" /> Scheduled message</label>
        </div>
        <div class="kac-groups">
        <div class="kac-group kac-g-int"
          title="INTERVAL group — how often it sends. Each row's minutes and seconds boxes ADD TOGETHER (2m + 32s = 2m 32s). The green readout above shows exactly what the script understands.">
          <div class="kac-g-head">
            <span class="kac-g-title">INTERVAL</span>
            <span class="kac-g-read" id="kac-int-read"></span>
          </div>
          <div class="kac-mmss">
            <input type="number" id="kac-int-m" min="0" step="1"
              title="Interval minutes. Adds to the seconds box beside it." />
            <span class="kac-u">m</span>
            <input type="number" id="kac-int-s" min="0" max="59" step="1"
              title="Interval seconds. Adds to the minutes box beside it — 2m + 32s means 2 minutes 32 seconds. Over 59 rolls into minutes automatically." />
            <span class="kac-u">s</span>
            <span class="kac-mm-max" id="kac-int-max-cell">
              <span class="kac-arrow">→</span>
              <input type="number" id="kac-int-max-m" min="0" step="1"
                title="Maximum interval minutes. Each send picks a random time between the left pair and this pair." />
              <span class="kac-u">m</span>
              <input type="number" id="kac-int-max-s" min="0" max="59" step="1"
                title="Maximum interval seconds. Each send picks a random time between the left pair and this pair." />
              <span class="kac-u">s</span>
            </span>
          </div>
        </div>
        <div class="kac-group kac-g-cool"
          title="COOLDOWN group — the minimum gap between any two sends. Each row's minutes and seconds boxes ADD TOGETHER. The blue readout above shows exactly what the script understands.">
          <div class="kac-g-head">
            <span class="kac-g-title">COOLDOWN</span>
            <span class="kac-g-read" id="kac-cool-read"></span>
          </div>
          <div class="kac-mmss">
            <input type="number" id="kac-cool-m" min="0" step="1"
              title="Cooldown minutes. Adds to the seconds box beside it." />
            <span class="kac-u">m</span>
            <input type="number" id="kac-cool-s" min="0" max="59" step="1"
              title="Cooldown seconds. Adds to the minutes box beside it. Two sends never land closer than this. Over 59 rolls into minutes automatically." />
            <span class="kac-u">s</span>
            <span class="kac-mm-max" id="kac-cool-max-cell">
              <span class="kac-arrow">→</span>
              <input type="number" id="kac-cool-max-m" min="0" step="1"
                title="Maximum cooldown minutes. Each cycle picks a random gap between the left pair and this pair." />
              <span class="kac-u">m</span>
              <input type="number" id="kac-cool-max-s" min="0" max="59" step="1"
                title="Maximum cooldown seconds. Each cycle picks a random gap between the left pair and this pair." />
              <span class="kac-u">s</span>
            </span>
          </div>
        </div>
        </div>
        <div class="kac-row" id="kac-rotate-row">
          <label title="Extra messages to cycle through, separated by commas. The Message above is always first, then each keyword in turn, then it loops. Example: KEKW, LULW, Cx W. Whitespace around commas is trimmed; blank entries are ignored. Only used while Anti-duplicate is on.">Rotation keywords (comma-separated) <span class="kac-q">?</span></label>
          <input type="text" id="kac-rotate" placeholder="e.g. KEKW, LULW, Cx W"
            title="Comma-separated list of additional messages. Sends cycle: Message, then each keyword, then loop. Leave empty to just send the Message. Only active while Anti-duplicate is checked." />
        </div>
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
        <div class="kac-inline">
          <label class="kac-inline-lbl"
            title="The mention watcher reads the on-page chat for messages that mention or reply to your username and logs them to the Mentions tab. Read-only — it never sends or replies. It is INDEPENDENT of the main Start button and works even when the auto-sender is stopped.">Mention watcher <span class="kac-q">?</span></label>
          <div class="kac-inat" title="Type your Kick username without the @ — the @ is added automatically.">
            <span>@</span>
            <input type="text" id="kac-watch-user" placeholder="your_kick_name"
              title="Type your exact Kick username WITHOUT the @ (it's shown for you). The watcher flags any chat message containing @thisname or a reply to it." />
          </div>
          <button class="kac-btn kac-btn-w" id="kac-watch-btn"
            title="Start / stop watching chat for @mentions and replies to your username. INDEPENDENT of the main Start button — it works even when the auto-sender is stopped. Matches appear in the Mentions tab.">Start watching</button>
        </div>
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
        <div class="kac-div"></div>
        <div class="kac-set-h"
          title="Additional independent senders, each with its own message, timing, and Start/Stop — running alongside (and separate from) the main sender above. Use + Duplicate sender to add one pre-filled from the current main settings.">EXTRA SENDERS</div>
        <div id="kac-extras"></div>
        <button class="kac-btn kac-btn-sm" id="kac-extra-add"
          title="Add another independent sender, pre-filled from the current main Message and timing. Each extra has its own Start/Stop, Send now, and Remove. One message is still sent per second at most across ALL senders, so they never crowd each other.">+ Duplicate sender</button>
        <div id="kac-explain">
          <div id="kac-explain-head"
            title="Plain-English summary of exactly what your current settings will do. Updates live as you change anything. Click to collapse or expand — the state is remembered.">
            <span>WHAT WILL HAPPEN</span><span id="kac-explain-arrow">▾</span>
          </div>
          <div id="kac-explain-body"></div>
        </div>
      </div>
      <div id="kac-resize" title="Drag the corner to resize the controls (taller also makes the log taller)."></div>
      </div>
      <div id="kac-drawer">
        <div id="kac-drawer-head">
          <button id="kac-tab-log" class="kac-tab active" title="Activity log: sends, start/stop, and errors.">Log</button>
          <button id="kac-tab-men" class="kac-tab" title="Mentions: messages that @ you or reply to you (needs the watcher enabled below). Saved locally, so they survive a browser reload — use Clear to wipe them.">Mentions <span id="kac-men-badge" class="kac-badge">0</span></button>
          <button id="kac-tab-set" class="kac-tab" title="Settings: mention-watcher ignore list, sound, and webhook options.">⚙</button>
          <button id="kac-clear" title="Clear the list shown in the current tab (Log or Mentions).">Clear</button>
        </div>
        <div id="kac-drawer-body">
        <div id="kac-log"
          title="Activity log: timestamped record of sends, start/stop, and any errors (e.g. 'Chat input not found'). Keeps the last ~40 lines. Toggle it with the arrow in the title bar."></div>
        <div id="kac-mentions" style="display:none"
          title="@mentions and replies to your username, captured from chat. Read-only — the script never replies. Saved locally, so they come back after a browser reload; Clear wipes them."></div>
        <div id="kac-settings" style="display:none">
          <div class="kac-set-h">MENTION WATCHER</div>
          <div class="kac-row">
            <label title="Usernames the watcher will skip, separated by commas. Their messages never count as mentions — mainly for chat bots (e.g. the points bot that replies to !claim and would otherwise ping you every time). The @ is optional and matching ignores capitalisation. Add or remove any names you like.">Ignore senders (comma-separated) <span class="kac-q">?</span></label>
            <input type="text" id="kac-watch-ignore" placeholder="e.g. Botrix, StreamElements"
              title="Comma-separated usernames to ignore. Messages from these senders are never logged as mentions. The @ is optional; matching is case-insensitive. Leave empty to catch everyone." />
          </div>
          <div class="kac-row">
            <label title="Which Kick tabs the mention watcher reads. All open channels: every open Kick tab is monitored, no matter which streamer it shows. Only the target channel: a tab only monitors while it's on kick.com/<target> — the same Target channel used for sending — and sits idle on any other channel.">Watch scope <span class="kac-q">?</span></label>
            <select id="kac-watch-scope"
              title="All open channels = every open Kick tab is monitored. Only the target channel = a tab only monitors while it's showing kick.com/<target> (the same target the sender uses), idle otherwise.">
              <option value="all">All open channels</option>
              <option value="target">Only the target channel</option>
            </select>
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
          <div class="kac-div"></div>
          <div class="kac-set-h">REMOTE CONTROL</div>
          <label class="kac-check"
            title="Mirror this panel to a small server running on THIS PC, so you can start/stop it and read the log and mentions from your phone. Run 'node server.js' in the remote folder first. Purely optional — if the server isn't running, nothing happens and sending is unaffected.">
            <input type="checkbox" id="kac-rem-en" /> Enable remote control</label>
          <div class="kac-row" id="kac-rem-wrap">
            <label title="Must match the port server.js is listening on (it prints the address to open on your phone when it starts). Default 3300.">Server port <span class="kac-q">?</span></label>
            <input type="number" id="kac-rem-port" min="1" max="65535" step="1"
              title="Port that server.js is listening on. Default 3300." />
            <div id="kac-rem-status"
              title="Whether this tab can reach the local remote server."></div>
          </div>
          <div class="kac-div"></div>
          <div class="kac-set-h">$CHAT MONITOR (SHOOVY)</div>
          <label class="kac-check"
            title="Watch the $CHAT (Chat Hype Index) ticker on shoovy.wtf/stocks and alert (log + beep + optional webhook) whenever it prints a new 24-hour low. ONLY active when the Target channel is 'shoovy' AND the remote server (the .bat) is running — the shoovy.wtf API sends no CORS header, so the browser can't read it directly; the local server polls it and pushes the alert here.">
            <input type="checkbox" id="kac-chat-en" /> Alert on new $CHAT 24h lows</label>
          <div class="kac-div"></div>
          <div class="kac-set-h">BACKUP</div>
          <div class="kac-btns">
            <button class="kac-btn kac-btn-sm" id="kac-export"
              title="Save every setting (target, messages, timings, keywords, scheduled message, watcher, webhook) to a .json file you can keep as a backup. NOTE: the file includes your webhook URL — keep it private. Mentions are not included.">Backup settings</button>
            <button class="kac-btn kac-btn-sm" id="kac-import"
              title="Load a previously saved .json backup and apply it. Sending is left stopped afterwards so nothing fires unexpectedly — press Start when ready.">Restore</button>
          </div>
          <input type="file" id="kac-import-file" accept="application/json,.json" style="display:none" />
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
      watchScope: p.querySelector('#kac-watch-scope'),
      whEn: p.querySelector('#kac-wh-en'),
      whWrap: p.querySelector('#kac-wh-wrap'),
      whUrl: p.querySelector('#kac-wh-url'),
      whFmt: p.querySelector('#kac-wh-fmt'),
      whTest: p.querySelector('#kac-wh-test'),
      remEn: p.querySelector('#kac-rem-en'),
      remWrap: p.querySelector('#kac-rem-wrap'),
      remPort: p.querySelector('#kac-rem-port'),
      remStatus: p.querySelector('#kac-rem-status'),
      chatEn: p.querySelector('#kac-chat-en'),
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
      extras: p.querySelector('#kac-extras'),
      extraAdd: p.querySelector('#kac-extra-add'),
      exportBtn: p.querySelector('#kac-export'),
      importBtn: p.querySelector('#kac-import'),
      importFile: p.querySelector('#kac-import-file'),
      log: p.querySelector('#kac-log'),
      resize: p.querySelector('#kac-resize'),
    };

    // The title bar carries the running version.
    ui.titleEl.textContent = TITLE;

    applySettingsToUI();
    restoreMentions();
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
    ui.watchScope.addEventListener('change', () => {
      settings.watchScope = ui.watchScope.value;
      saveSettings();
      // scanChat reads scope live each tick, so no restart is strictly needed,
      // but refresh the watcher and status so the change is reflected at once.
      applyWatcher();
      updateWatchStatus();
    });
    ui.whEn.addEventListener('change', () => {
      settings.webhookEnabled = ui.whEn.checked;
      ui.whWrap.classList.toggle('hidden', !settings.webhookEnabled);
      saveSettings();
    });
    ui.whUrl.addEventListener('input', () => { settings.webhookUrl = ui.whUrl.value; saveSettings(); });
    ui.whFmt.addEventListener('change', () => { settings.webhookFormat = ui.whFmt.value; saveSettings(); });
    ui.remEn.addEventListener('change', () => {
      settings.remoteEnabled = ui.remEn.checked;
      ui.remWrap.classList.toggle('hidden', !settings.remoteEnabled);
      remoteOk = null;
      saveSettings();
      applyRemote();
      updateRemoteStatus();
    });
    ui.remPort.addEventListener('input', () => {
      settings.remotePort = Math.max(1, Math.min(65535, parseInt(ui.remPort.value, 10) || 3300));
      remoteOk = null;
      saveSettings();
      updateRemoteStatus();
    });
    ui.chatEn.addEventListener('change', () => {
      settings.chatMonitor = ui.chatEn.checked;
      saveSettings();
      updateExplain();
    });
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
        kind: 'mention',
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
        // Clears the display AND the saved history. The seen-set stays, though —
        // wiping it would make the next scan re-alert everything still on screen
        // and immediately refill the list we just emptied.
        ui.mentions.textContent = '';
        mentionLog = [];
        saveMentions();
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
    ui.extraAdd.addEventListener('click', addExtraFromMain);
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
    ui.watchScope.value = settings.watchScope;
    ui.whEn.checked = settings.webhookEnabled;
    ui.whUrl.value = settings.webhookUrl;
    ui.whFmt.value = settings.webhookFormat;
    ui.whWrap.classList.toggle('hidden', !settings.webhookEnabled);
    ui.remEn.checked = settings.remoteEnabled;
    ui.remPort.value = settings.remotePort;
    ui.remWrap.classList.toggle('hidden', !settings.remoteEnabled);
    ui.chatEn.checked = settings.chatMonitor;
    updateRemoteStatus();
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
    renderExtras();
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

  // Generic minutes+seconds binder that reads/writes via getter/setter callbacks
  // instead of a settings KEY — used by the extra-sender cards, which store their
  // timing on the sender object rather than in `settings`.
  function bindMMSSObj(mEl, sEl, getter, setter, minTotal, after) {
    writeMMSS(mEl, sEl, getter());
    const apply = () => {
      setter(Math.max(minTotal, readMMSS(mEl, sEl)));
      if (after) after();
    };
    mEl.addEventListener('input', apply);
    sEl.addEventListener('input', apply);
    const normalise = () => writeMMSS(mEl, sEl, getter());
    mEl.addEventListener('change', normalise);
    sEl.addEventListener('change', normalise);
  }

  // ---- Extra-sender cards -------------------------------------------------
  // Tiny element factory: create an element, optionally set a class and a bag of
  // attributes ({text} sets textContent; everything else is setAttribute).
  function mkEl(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) {
      for (const k in attrs) {
        if (k === 'text') e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
    }
    return e;
  }

  // Build one coloured INTERVAL/COOLDOWN group (mirrors the main sender's markup)
  // and hand back the group element plus its input/readout refs.
  function buildTimingGroup(title, cls) {
    const group = mkEl('div', 'kac-group ' + cls);
    const read = mkEl('span', 'kac-g-read');
    const gh = mkEl('div', 'kac-g-head');
    gh.append(mkEl('span', 'kac-g-title', { text: title }), read);

    const mEl = mkEl('input', null, { type: 'number', min: '0', step: '1' });
    const sEl = mkEl('input', null, { type: 'number', min: '0', max: '59', step: '1' });
    const mMaxEl = mkEl('input', null, { type: 'number', min: '0', step: '1' });
    const sMaxEl = mkEl('input', null, { type: 'number', min: '0', max: '59', step: '1' });

    const mCell = mkEl('span', 'kac-mm-max');
    mCell.append(
      mkEl('span', 'kac-arrow', { text: '→' }),
      mMaxEl, mkEl('span', 'kac-u', { text: 'm' }),
      sMaxEl, mkEl('span', 'kac-u', { text: 's' }),
    );

    const mmss = mkEl('div', 'kac-mmss');
    mmss.append(
      mEl, mkEl('span', 'kac-u', { text: 'm' }),
      sEl, mkEl('span', 'kac-u', { text: 's' }),
      mCell,
    );
    group.append(gh, mmss);
    return { group, read, mCell, mEl, sEl, mMaxEl, sMaxEl };
  }

  // Live readout beside each group title (per-sender variant of updateTimingReadouts).
  function updateExtraReadouts(sender) {
    const c = extraCards[sender.id];
    if (!c) return;
    const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
    const set = (el, a, b, single, verb) => {
      if (!el) return;
      if (sender.randomize) {
        el.textContent = `${fmtMSc(a)}–${fmtMSc(b)}`;
        el.title = `= ${verb} ${fmtMS(a)} – ${fmtMS(b)} (a random ${a}–${b} seconds, re-rolled each time)`;
      } else {
        el.textContent = fmtMSc(single);
        el.title = `= ${verb} ${fmtMS(single)} (${single} seconds)`;
      }
    };
    set(c.intRead,
      lo(sender.intervalSec, sender.intervalMaxSec),
      hi(sender.intervalSec, sender.intervalMaxSec),
      sender.intervalSec, 'sends every');
    set(c.coolRead,
      lo(sender.cooldownSec, sender.cooldownMaxSec),
      hi(sender.cooldownSec, sender.cooldownMaxSec),
      sender.cooldownSec, 'never closer than');
    c.intMaxCell.classList.toggle('hidden', !sender.randomize);
    c.coolMaxCell.classList.toggle('hidden', !sender.randomize);
  }

  // Start/Stop button label + colour and the header dot.
  function updateExtraCardControls(sender) {
    const c = extraCards[sender.id];
    if (!c) return;
    c.toggleBtn.textContent = sender.running ? 'Stop' : 'Start';
    c.toggleBtn.className = 'kac-btn kac-btn-sm ' + (sender.running ? 'kac-ex-stop' : 'kac-ex-go');
    c.dot.classList.toggle('on', !!sender.running);
  }

  // Header dot + preview + mini "next in Xs · sent N" line.
  function updateExtraStatus(sender) {
    const c = extraCards[sender.id];
    const rt = extraRuntime[sender.id];
    if (!c || !rt) return;
    c.dot.classList.toggle('on', !!sender.running);
    c.prev.textContent = (sender.message || '(no text)').slice(0, 18) || '(no text)';
    if (sender.running) {
      if (isOnTarget()) {
        const secs = Math.max(0, Math.ceil((rt.nextSendAt - Date.now()) / 1000));
        c.mini.innerHTML = `next in <b>${secs}s</b> · sent ${rt.sendCount}`;
      } else {
        c.mini.innerHTML = `paused (off-target) · sent ${rt.sendCount}`;
      }
    } else {
      c.mini.innerHTML = `stopped · sent ${rt.sendCount}`;
    }
  }

  // Create the DOM for one extra sender and wire every control to mutate the
  // sender object + persist. Elements are built with createElement (no ids), so
  // multiple cards never collide.
  function buildExtraCard(sender) {
    const card = mkEl('div', 'kac-ex-card');
    card.dataset.id = sender.id;

    // Header (click toggles collapse; the × removes).
    const head = mkEl('div', 'kac-ex-head', {
      title: 'Click to collapse/expand this sender. The dot is green while it is running.',
    });
    const dot = mkEl('span', 'kac-ex-dot' + (sender.running ? ' on' : ''));
    const prev = mkEl('span', 'kac-ex-prev');
    const mini = mkEl('span', 'kac-ex-mini');
    const caret = mkEl('span', 'kac-ex-caret', { text: sender.collapsed ? '▸' : '▾' });
    const rm = mkEl('button', 'kac-ex-rm', { title: 'Remove this sender', text: '×' });
    head.append(dot, prev, mini, caret, rm);

    // Body.
    const body = mkEl('div', 'kac-ex-body' + (sender.collapsed ? ' hidden' : ''));

    const msgRow = mkEl('div', 'kac-row');
    const msgLbl = mkEl('label', null, { text: 'Message', title: 'The exact text this sender posts each time.' });
    const msgInput = mkEl('input', null, { type: 'text', placeholder: 'message', title: 'The exact text this sender posts each time.' });
    msgInput.value = sender.message || '';
    msgRow.append(msgLbl, msgInput);

    const checks = mkEl('div', 'kac-checks');
    const randLbl = mkEl('label', 'kac-check', { title: 'Randomize this sender’s timing between the Min and Max of each group below, re-rolled each cycle.' });
    const randCb = mkEl('input', null, { type: 'checkbox' });
    randCb.checked = !!sender.randomize;
    randLbl.append(randCb, document.createTextNode(' Randomize'));
    const dupLbl = mkEl('label', 'kac-check', { title: 'Append invisible zero-width characters so Kick won’t reject identical repeats.' });
    const dupCb = mkEl('input', null, { type: 'checkbox' });
    dupCb.checked = !!sender.antiDup;
    dupLbl.append(dupCb, document.createTextNode(' Anti-duplicate'));
    checks.append(randLbl, dupLbl);

    // Rotation keywords — mirrors the main sender's field, shown only while THIS
    // sender's anti-duplicate is on.
    const rotTip = "Extra messages to cycle through, separated by commas. The card's Message is always first, then each keyword in turn, then it loops. Only used while this sender's Anti-duplicate is on.";
    const rotRow = mkEl('div', 'kac-row' + (sender.antiDup ? '' : ' hidden'));
    const rotLbl = mkEl('label', null, { text: 'Rotation keywords (comma-separated)', title: rotTip });
    const rotInput = mkEl('input', null, { type: 'text', placeholder: 'e.g. KEKW, LULW, Cx W', title: rotTip });
    rotInput.value = sender.rotateKeywords || '';
    rotRow.append(rotLbl, rotInput);

    const groups = mkEl('div', 'kac-groups');
    const iv = buildTimingGroup('INTERVAL', 'kac-g-int');
    const cool = buildTimingGroup('COOLDOWN', 'kac-g-cool');
    iv.group.title = 'How often this sender posts. Minutes + seconds add together.';
    cool.group.title = 'Minimum gap before this sender posts again. Minutes + seconds add together.';
    groups.append(iv.group, cool.group);

    const btns = mkEl('div', 'kac-btns');
    const toggleBtn = mkEl('button', 'kac-btn kac-btn-sm', { title: 'Start / stop just this sender. Independent of the main Start.' });
    const nowBtn = mkEl('button', 'kac-btn kac-btn-sm', { text: 'Send now', title: 'Send this sender’s message once, right now (only on the target channel).' });
    btns.append(toggleBtn, nowBtn);

    body.append(msgRow, checks, rotRow, groups, btns);
    card.append(head, body);

    // Stash refs BEFORE wiring so status/readout updaters can find them.
    extraCards[sender.id] = {
      card, dot, prev, mini, toggleBtn,
      intRead: iv.read, coolRead: cool.read,
      intMaxCell: iv.mCell, coolMaxCell: cool.mCell,
    };

    // Header collapse / remove.
    head.addEventListener('click', (e) => {
      if (e.target === rm) return;
      sender.collapsed = !sender.collapsed;
      body.classList.toggle('hidden', sender.collapsed);
      caret.textContent = sender.collapsed ? '▸' : '▾';
      saveSettings();
    });
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeExtra(sender); });

    // Message + toggles.
    msgInput.addEventListener('input', () => {
      sender.message = msgInput.value;
      saveSettings();
      updateExtraStatus(sender);
    });
    randCb.addEventListener('change', () => {
      sender.randomize = randCb.checked;
      updateExtraReadouts(sender);
      saveSettings();
      if (sender.running) scheduleExtra(sender);
      updateExtraStatus(sender);
    });
    dupCb.addEventListener('change', () => {
      sender.antiDup = dupCb.checked;
      rotRow.classList.toggle('hidden', !sender.antiDup);
      const rt = extraRuntime[sender.id];
      if (rt) rt.rotateIndex = 0; // restart the cycle when anti-dup toggles
      saveSettings();
    });
    rotInput.addEventListener('input', () => {
      sender.rotateKeywords = rotInput.value;
      const rt = extraRuntime[sender.id];
      if (rt) rt.rotateIndex = 0; // restart the cycle when the list changes
      saveSettings();
    });

    // Timing. Reschedule if running so a mid-flight change takes effect at once.
    const afterTiming = () => {
      updateExtraReadouts(sender);
      saveSettings();
      if (sender.running) scheduleExtra(sender);
      updateExtraStatus(sender);
    };
    bindMMSSObj(iv.mEl, iv.sEl, () => sender.intervalSec, (v) => { sender.intervalSec = v; }, 1, afterTiming);
    bindMMSSObj(iv.mMaxEl, iv.sMaxEl, () => sender.intervalMaxSec, (v) => { sender.intervalMaxSec = v; }, 1, afterTiming);
    bindMMSSObj(cool.mEl, cool.sEl, () => sender.cooldownSec, (v) => { sender.cooldownSec = v; }, 0, afterTiming);
    bindMMSSObj(cool.mMaxEl, cool.sMaxEl, () => sender.cooldownMaxSec, (v) => { sender.cooldownMaxSec = v; }, 0, afterTiming);

    // Start/Stop + Send now.
    toggleBtn.addEventListener('click', () => (sender.running ? stopExtra(sender) : startExtra(sender)));
    nowBtn.addEventListener('click', () => sendNowExtra(sender));

    // Initial paint.
    updateExtraCardControls(sender);
    updateExtraReadouts(sender);
    updateExtraStatus(sender);
    return card;
  }

  // Clear and rebuild every extra-sender card from settings.extraSenders. Called
  // after load, add, remove, and any wholesale settings apply (restore/remote).
  function renderExtras() {
    if (!ui.extras) return;
    // Prune runtime for senders that no longer exist (e.g. after a restore).
    const liveIds = new Set(settings.extraSenders.map((s) => s.id));
    for (const k in extraRuntime) if (!liveIds.has(k)) delete extraRuntime[k];
    ui.extras.textContent = '';
    for (const k in extraCards) delete extraCards[k];
    for (const sender of settings.extraSenders) {
      if (!extraRuntime[sender.id]) initExtraRuntime(sender);
      ui.extras.appendChild(buildExtraCard(sender));
    }
  }

  // Compact form for the inline readout: "1m50s", "50s".
  function fmtMSc(total) {
    const t = Math.max(0, Math.floor(total || 0));
    const m = Math.floor(t / 60), s = t % 60;
    return m > 0 ? `${m}m${s}s` : `${s}s`;
  }

  // The "so we know the GUI understands it" readout, shown beside each group
  // title. Kept short to fit on one line; the full sentence lives in its tooltip.
  function updateTimingReadouts() {
    const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
    const set = (el, a, b, single, verb) => {
      if (!el) return;
      if (settings.randomize) {
        el.textContent = `${fmtMSc(a)}–${fmtMSc(b)}`;
        el.title = `= ${verb} ${fmtMS(a)} – ${fmtMS(b)} (a random ${a}–${b} seconds, re-rolled each time)`;
      } else {
        el.textContent = fmtMSc(single);
        el.title = `= ${verb} ${fmtMS(single)} (${single} seconds)`;
      }
    };
    set(ui.intRead,
      lo(settings.intervalSec, settings.intervalMaxSec),
      hi(settings.intervalSec, settings.intervalMaxSec),
      settings.intervalSec, 'sends every');
    set(ui.coolRead,
      lo(settings.cooldownSec, settings.cooldownMaxSec),
      hi(settings.cooldownSec, settings.cooldownMaxSec),
      settings.cooldownSec, 'never closer than');
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

  // Title-bar tail showing the active mention-watch scope, so it's visible even
  // when the panel is collapsed. Empty when the watcher is off or no username set.
  function watchTitleTail() {
    if (!settings.watchEnabled || !watchName()) return '';
    if (settings.watchScope === 'target') return ` · 👁 @${targetChannel() || '?'}`;
    return ' · 👁 all';
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
      const wtail = watchTitleTail();
      ui.titleEl.textContent = settings.collapsed
        ? `Paused @${target}${wtail}`
        : `${TITLE} · paused${wtail}`;
      return;
    }

    if (settings.running) {
      const secs = Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000));
      ui.status.innerHTML = `Running on <b>@${target}</b> — next in <b>${secs}s</b> · sent ${sendCount}${settings.randomize ? ' · rand' : ''}`;
      // Mirror into the title bar so it's visible even when collapsed, including
      // the scheduled-message countdown (e.g. !claim 3h59m) and the watch scope.
      const tail = secondTitleTail() + watchTitleTail();
      ui.titleEl.textContent = settings.collapsed
        ? `${secs}s · ${sendCount} sent${tail}`
        : `${TITLE} · ${secs}s · ${sendCount} sent${tail}`;
    } else {
      ui.status.innerHTML = `Idle · target @${target} · sent ${sendCount}`;
      const wtail = watchTitleTail();
      ui.titleEl.textContent = settings.collapsed
        ? `Idle · ${sendCount} sent${wtail}`
        : `${TITLE}${wtail}`;
    }
  }

  function log(msg, isErr) {
    // Kept in memory too so the remote page can show the same log.
    logLines.push({ t: new Date().toISOString(), m: String(msg), e: !!isErr });
    while (logLines.length > 60) logLines.shift();
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
    const count = `${menTotal} mention${menTotal === 1 ? '' : 's'}`;
    if (settings.watchScope === 'target') {
      // Target-only scope: note it, and flag when this tab is idle because it's
      // not currently on the target channel.
      if (isOnTarget()) {
        ui.watchStatus.innerHTML = `Watching <b>@${name}</b> (target only) · ${count}`;
      } else {
        ui.watchStatus.innerHTML = `Watching <b>@${name}</b> (target only) — idle here (@${currentChannel() || '—'}) · ${count}`;
      }
      return;
    }
    ui.watchStatus.innerHTML = `Watching <b>@${name}</b> · ${count}`;
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
      const channel = data.channel || '';
      const chSuffix = channel ? ` · #${channel}` : '';
      const titleBase = data.kind === 'reply' ? 'Replied to you'
        : data.kind === 'quote' ? 'Reply mentioning you'
        : 'Mentioned you';
      const color = data.kind === 'reply' ? 4890111      // 0x4a9fff blue
        : data.kind === 'quote' ? 16761446               // 0xffc266 amber
        : 5504536;                                        // 0x53fc18 green

      // Build the field list conditionally — Discord rejects a field with an
      // empty value, so only push fields that actually carry content.
      const fields = [];
      if (channel) {
        fields.push({
          name: 'Channel',
          value: `[kick.com/${channel}](https://kick.com/${channel})`,
          inline: true,
        });
      }
      if (data.kind === 'quote' && data.replyQuote) {
        fields.push({
          name: 'In reply to' + (data.replyTo ? ` @${data.replyTo}` : ''),
          value: data.replyQuote.slice(0, 300),
        });
      }

      const embed = {
        author: { name: data.sender || 'someone' },
        title: titleBase + chSuffix,
        description: (data.message && data.message.trim())
          ? data.message.slice(0, 1000)
          : '(no text)',
        color,
        timestamp: data.ts,
        footer: { text: 'Kick Auto-Chat' + (channel ? ` · kick.com/${channel}` : '') },
      };
      if (channel) embed.url = `https://kick.com/${channel}`;
      if (fields.length) embed.fields = fields;

      body = JSON.stringify({
        username: 'Kick Auto-Chat',
        embeds: [embed],
        // Never let a chat message trigger @everyone/@here pings in Discord.
        allowed_mentions: { parse: [] },
      });
    } else {
      // Raw JSON: spreads all data fields (channel included) plus a source tag.
      body = JSON.stringify({ source: 'kick-autochat', ...data });
    }

    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then((r) => { if (!r.ok) log(`Webhook failed: HTTP ${r.status}`, true); })
      .catch((e) => log(`Webhook error: ${e.message} (blocked by CORS?)`, true));
  }

  // Dedicated webhook for a $CHAT new-24h-low alert (pushed by the server). Kept
  // separate from postWebhook so the Discord embed is a distinct RED market-alert
  // card rather than a mention card. Same enable/URL/format gating as postWebhook.
  function postChatLowWebhook(a) {
    if (!settings.webhookEnabled) return;
    const url = (settings.webhookUrl || '').trim();
    if (!url) return;
    const n2 = (v) => Number(v).toFixed(2);

    let body;
    if (settings.webhookFormat === 'discord') {
      body = JSON.stringify({
        username: 'Kick Auto-Chat',
        embeds: [{
          title: '$CHAT — new 24h low',
          url: 'https://shoovy.wtf/stocks#stocks',
          color: 15158332, // 0xE74C3C red
          fields: [
            { name: 'New low', value: '$' + n2(a.low), inline: true },
            { name: 'Previous', value: '$' + n2(a.prev), inline: true },
            { name: 'Price', value: '$' + n2(a.price), inline: true },
            { name: 'Change %', value: n2(a.change_pct) + '%', inline: true },
          ],
          footer: { text: 'shoovy.wtf/stocks' },
          timestamp: new Date().toISOString(),
        }],
        // Never let an alert trigger @everyone/@here pings in Discord.
        allowed_mentions: { parse: [] },
      });
    } else {
      // Raw JSON: the alert fields plus a source/type tag for a custom endpoint.
      body = JSON.stringify({
        source: 'kick-autochat',
        type: 'chatLow',
        low: a.low,
        prev: a.prev,
        price: a.price,
        change_pct: a.change_pct,
      });
    }

    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then((r) => { if (!r.ok) log(`Webhook failed: HTTP ${r.status}`, true); })
      .catch((e) => log(`Webhook error: ${e.message} (blocked by CORS?)`, true));
  }

  // Local date + time, e.g. "7/16/26, 2:54:07 PM". Mentions outlive the session
  // now, so a bare clock time would be ambiguous.
  function stampLocal(d) {
    try {
      return d.toLocaleString([], {
        year: '2-digit', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
      });
    } catch (e) {
      return d.toLocaleString();
    }
  }

  function loadMentions() {
    try {
      const raw = localStorage.getItem(MEN_KEY);
      if (!raw) return [];
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a.slice(-MEN_MAX) : [];
    } catch (e) {
      return [];
    }
  }

  function saveMentions() {
    try {
      localStorage.setItem(MEN_KEY, JSON.stringify(mentionLog.slice(-MEN_MAX)));
    } catch (e) { /* ignore quota errors */ }
  }

  // Render one stored record. Used both for live mentions and for the list
  // restored on reload, so they can't drift apart.
  function renderMention(rec) {
    if (!ui.mentions) return;
    const body = rec.body || '(no text)';
    const prefix = rec.kind === 'reply' ? '↩ ' : rec.kind === 'quote' ? '❝ ' : '';
    const reUser = rec.kind === 'quote' && rec.replyTo ? ` (re: @${rec.replyTo})` : '';

    const div = document.createElement('div');
    div.className = 'kac-men-item ' + rec.kind;
    // Built from separate spans with textContent, so chat text can't inject markup.
    const tEl = document.createElement('span');
    tEl.className = 'kac-men-t';
    tEl.textContent = `[${stampLocal(new Date(rec.ts))}] `;
    div.appendChild(tEl);
    // Which channel this mention was captured on (multi-stream monitoring). Older
    // records predating this field simply omit the tag.
    if (rec.channel) {
      const cEl = document.createElement('span');
      cEl.className = 'kac-men-c';
      cEl.textContent = `[${rec.channel}] `;
      div.appendChild(cEl);
    }
    const sEl = document.createElement('span');
    sEl.className = 'kac-men-s';
    sEl.textContent = `${prefix}${rec.sender || '?'}${reUser}: `;
    div.appendChild(sEl);
    const bEl = document.createElement('span');
    bEl.textContent = body;
    div.appendChild(bEl);
    // For a quote match, show what was quoted — that's where your name was.
    if (rec.kind === 'quote' && rec.replyQuote) {
      const qEl = document.createElement('div');
      qEl.className = 'kac-men-q';
      qEl.textContent = '↳ ' + rec.replyQuote.slice(0, 140);
      div.appendChild(qEl);
    }
    ui.mentions.appendChild(div);
    ui.mentions.scrollTop = ui.mentions.scrollHeight;
    while (ui.mentions.childNodes.length > MEN_MAX) ui.mentions.removeChild(ui.mentions.firstChild);
  }

  // Re-draw the saved mentions after a reload.
  function restoreMentions() {
    if (!ui.mentions) return;
    mentionLog = loadMentions();
    ui.mentions.textContent = '';
    for (const rec of mentionLog) renderMention(rec);
    menTotal = mentionLog.length;
    unreadMen = 0; // restored history isn't "new"
    updateMenBadge();
    updateWatchStatus();
  }

  // Stable identity of a mention record, used to collapse the same mention seen
  // by two tabs watching the same channel. Prefer the id baked in at capture
  // time; fall back to a composite for older records that lack one (treat a
  // missing channel as '').
  function mentionId(rec) {
    if (rec && rec.id) return rec.id;
    return (rec.channel || '') + '|' + (rec.ts || '') + '|' +
      (rec.sender || '') + '|' + (rec.body || '').slice(0, 140);
  }

  // Read-merge-write the shared mentions store so two tabs capturing on the same
  // (or different) channels never clobber each other. Union the freshly captured
  // records with whatever is currently persisted — keyed by id, first-seen wins —
  // sort ascending by ts, cap to MEN_MAX, persist, and adopt the merged array as
  // our in-memory list.
  function mergeMentions(newRecs) {
    const byId = new Map();
    const add = (rec) => {
      const key = mentionId(rec);
      if (!byId.has(key)) byId.set(key, rec); // first-seen wins
    };
    for (const r of loadMentions()) add(r);       // whatever another tab wrote
    for (const r of (newRecs || [])) add(r);      // our just-captured additions
    let merged = [...byId.values()];
    merged.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
    if (merged.length > MEN_MAX) merged = merged.slice(-MEN_MAX);
    try {
      localStorage.setItem(MEN_KEY, JSON.stringify(merged));
    } catch (e) { /* ignore quota errors */ }
    mentionLog = merged;
    return merged;
  }

  function addMention(m) {
    if (!ui.mentions) return;
    const now = new Date();
    const channel = currentChannel();
    const bodySlice = (m.body || '').slice(0, 140);
    const ts = now.toISOString();
    // Prefer Kick's own DOM timestamp for the id so the same line seen by two
    // tabs on this channel collapses; fall back to our capture time when the
    // line carries no timestamp (that fallback won't dedupe across tabs, but a
    // duplicate is far better than losing the mention).
    const sig = (m.domTs || ts) + '|' + (m.sender || '') + '|' + bodySlice;
    const rec = {
      id: channel + '|' + sig,
      ts,
      channel,
      kind: m.kind,
      sender: m.sender || '',
      body: m.body || '',
      replyTo: m.rep ? m.rep.user : '',
      replyQuote: m.rep ? m.rep.quote : '',
    };

    // Merge into the shared store, then repaint from the merged result so the
    // panel reflects anything a sibling tab added since our last write.
    mergeMentions([rec]);
    ui.mentions.textContent = '';
    for (const r of mentionLog) renderMention(r);

    menTotal = mentionLog.length;
    updateWatchStatus();
    if (activeTab !== 'men') { unreadMen++; updateMenBadge(); }
    if (settings.watchSound) beep();
    postWebhook({
      channel: currentChannel(),
      sender: rec.sender,
      message: rec.body || '(no text)',
      kind: rec.kind,                      // 'mention' | 'reply' | 'quote'
      isReply: rec.kind === 'reply',
      replyTo: rec.replyTo,
      replyQuote: rec.replyQuote,
      ts: rec.ts,                          // UTC, machine-readable
      tsLocal: stampLocal(now),            // your local date + time
    });
  }

  // Called once per new line — scanChat's seen-set already handles de-duping.
  function processChatLine(target, name) {
    const sender = extractSender(target);
    if (sender && sender.toLowerCase() === name.toLowerCase()) return; // your own message
    if (isIgnoredSender(sender)) return; // bots / muted senders

    const c = classifyLine(target, name);
    if (!c.hit) return;

    // Kick's own timestamp for this line (present in the DOM even when hidden by
    // CSS) gives a stable, tab-independent component for the mention id so the
    // same line captured by two tabs on this channel collapses to one.
    const tEl = target.querySelector('span[style*="chatroom-timestamps-display"]');
    const domTs = tEl ? (tEl.textContent || '').trim() : '';

    addMention({ kind: c.kind, sender, body: c.body, rep: c.rep, domTs });
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
    // Watch scope: when set to 'target', a tab only monitors while it's actually
    // showing the target channel. Returning here BEFORE the seeding block means an
    // off-target tab never seeds — so navigating it onto the target starts a clean
    // watch (seeds once), and navigating away stops it. Read live every tick.
    if (settings.watchScope === 'target' && !isOnTarget()) return;
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
  // Remote control (opt-in) — mirror state to a small local server and take
  // commands back from it, so a phone on the LAN can drive this tab.
  //
  // Everything here is wrapped and best-effort: if the server isn't running the
  // sync silently no-ops. It must never be able to disturb sending.
  // Note kick.com is HTTPS, so we can only reach 127.0.0.1 (browsers treat
  // localhost as trustworthy); the phone reaches the same server over the LAN.
  // ----------------------------------------------------------------------
  // Whitelist of settings the phone remote may edit. ONLY these keys are ever
  // accepted from /cmd — the remote-connection keys (remoteEnabled, remotePort),
  // `running` (use start/stop), and pure-UI keys (collapsed, logOpen, pos, size)
  // are deliberately absent so the phone can neither cut its own link nor fight
  // the PC over window chrome. Each entry carries the coerce rule and a human
  // label used in the activity log so every change is confirmed on both panels.
  const REMOTE_EDIT = {
    targetChannel:  { type: 'string', trim: true, label: 'Target channel' },
    message:        { type: 'string', label: 'Message' },
    intervalSec:    { type: 'int', min: 1, label: 'Interval min (s)' },
    intervalMaxSec: { type: 'int', min: 1, label: 'Interval max (s)' },
    cooldownSec:    { type: 'int', min: 0, label: 'Cooldown min (s)' },
    cooldownMaxSec: { type: 'int', min: 0, label: 'Cooldown max (s)' },
    randomize:      { type: 'bool', label: 'Randomize' },
    antiDup:        { type: 'bool', label: 'Anti-duplicate' },
    rotateKeywords: { type: 'string', label: 'Rotation keywords' },
    secondEnabled:  { type: 'bool', label: 'Scheduled message' },
    secondMessage:  { type: 'string', label: 'Scheduled message' },
    secondValue:    { type: 'int', min: 1, label: 'Scheduled every' },
    secondUnit:     { type: 'enum', values: ['minutes', 'hours'], label: 'Scheduled unit' },
    watchEnabled:   { type: 'bool', label: 'Mention watcher' },
    watchUsername:  { type: 'string', trim: true, label: 'Watch username' },
    watchScope:     { type: 'enum', values: ['all', 'target'], label: 'Watch scope' },
    watchSound:     { type: 'bool', label: 'Sound on mention' },
    watchBareName:  { type: 'bool', label: 'Match name without @' },
    ignoreSenders:  { type: 'string', label: 'Ignore senders' },
    webhookEnabled: { type: 'bool', label: 'Webhook forwarding' },
    webhookUrl:     { type: 'string', label: 'Webhook URL' },
    webhookFormat:  { type: 'enum', values: ['discord', 'json'], label: 'Webhook format' },
    chatMonitor:    { type: 'bool', label: '$CHAT 24h-low monitor' },
  };

  function buildRemoteState() {
    const secActive = settings.secondEnabled && (settings.secondMessage || '').trim();
    // Current values of exactly the editable keys, so the phone's Settings form
    // can populate itself. Booleans are normalized; webhookUrl is intentionally
    // included (the phone is a trusted LAN device per the product decision).
    const editable = {};
    for (const k of Object.keys(REMOTE_EDIT)) {
      editable[k] = REMOTE_EDIT[k].type === 'bool' ? !!settings[k] : settings[k];
    }
    return {
      version: VERSION,
      running: !!settings.running,
      // "Is anything running" — main OR any extra sender. Lets the phone's
      // kill-switch stay available even when only a duplicate is running.
      anyRunning: !!settings.running
        || (Array.isArray(settings.extraSenders) && settings.extraSenders.some(s => s && s.running)),
      onTarget: isOnTarget(),
      target: targetChannel(),
      here: currentChannel(),
      message: settings.message,
      sendCount,
      nextInSec: settings.running ? Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000)) : null,
      secondMessage: secActive ? (settings.secondMessage || '').trim() : '',
      secondInSec: (secActive && settings.running)
        ? Math.max(0, Math.ceil((secondNextSendAt - Date.now()) / 1000)) : null,
      watching: !!settings.watchEnabled,
      watchName: watchName(),
      menTotal,
      unread: unreadMen,
      // EFFECTIVE $CHAT-monitor flag the server keys its polling on: the raw
      // setting AND the target being shoovy. Kept separate from settings.chatMonitor
      // (the raw toggle) so the server only polls shoovy.wtf when it should.
      chatMonitor: !!settings.chatMonitor && targetChannel() === 'shoovy',
      log: logLines.slice(-40),
      mentions: mentionLog.slice(-40),
      settings: editable,
    };
  }

  // Apply a batch of {key: value} changes coming from the phone remote. Every
  // value is validated/coerced against REMOTE_EDIT here (never trust the wire),
  // no-ops are dropped, and each real change is logged so it shows on both the
  // PC panel and the phone's mirrored Log tab.
  function applyRemoteSettings(changes) {
    if (!changes || typeof changes !== 'object') return;
    const truncate = (v) => {
      const s = String(v);
      return s.length > 40 ? s.slice(0, 40) + '…' : s;
    };
    const fmtVal = (spec, v) => (spec.type === 'bool' ? (v ? 'on' : 'off') : truncate(v));

    let changed = false;
    for (const key of Object.keys(changes)) {
      const spec = REMOTE_EDIT[key];
      if (!spec) continue; // not editable / excluded key — ignore silently
      const raw = changes[key];
      let val;
      if (spec.type === 'int') {
        val = parseInt(raw, 10);
        if (!Number.isFinite(val)) continue; // unparseable number — skip
        if (val < spec.min) val = spec.min;   // clamp up to the minimum
      } else if (spec.type === 'bool') {
        val = raw === true;
      } else if (spec.type === 'enum') {
        val = String(raw);
        if (!spec.values.includes(val)) continue; // not an allowed value — reject
      } else { // string
        val = String(raw);
        if (spec.trim) val = val.trim(); // only channel/username are trimmed
      }
      const old = settings[key];
      if (val === old) continue; // no change — don't log a no-op
      settings[key] = val;
      changed = true;
      log(`Remote: ${spec.label}: "${fmtVal(spec, old)}" → "${fmtVal(spec, val)}"`);
    }

    if (!changed) return;
    // Persist, push every value back into the PC controls, then re-apply the
    // side effects those controls' own handlers would have run.
    saveSettings();
    applySettingsToUI(); // covers updateTimingReadouts / syncWatchControls / updateExplain
    applyWatcher();      // start/stop the watcher if watchEnabled/username changed
    updateStatus();
    if (settings.running) { scheduleNext(); scheduleSecond(); }
  }

  function applyRemoteCommand(cmd) {
    // Object form: a settings edit from the phone, e.g. {set:{message:'!fish'}},
    // or a $CHAT low alert pushed by the server, e.g. {chatLow:{low,prev,price,change_pct}}.
    if (cmd && typeof cmd === 'object') {
      if (cmd.set && typeof cmd.set === 'object') applyRemoteSettings(cmd.set);
      if (cmd.chatLow && typeof cmd.chatLow === 'object') {
        const a = cmd.chatLow;
        const n2 = (v) => Number(v).toFixed(2);
        log('$CHAT new 24h low: $' + n2(a.low) + ' (was $' + n2(a.prev) + ') · price $' + n2(a.price), false);
        if (settings.watchSound) beep();   // reuse the mention beep so it's audible
        postChatLowWebhook(a);             // no-ops unless webhook is enabled + URL set
      }
      return;
    }
    switch (cmd) {
      case 'start':
        if (!settings.running) { start(); log('Remote: start'); }
        break;
      case 'stop':
        // Global kill-switch from the phone: stops the main AND all extras,
        // even when only a duplicate sender is running.
        stopAll();
        break;
      case 'sendNow':
        log('Remote: send now');
        sendNow();
        break;
      case 'watchOn':
        if (!settings.watchEnabled && watchName()) {
          settings.watchEnabled = true;
          saveSettings(); applyWatcher(); syncWatchControls();
          log('Remote: watching on');
        }
        break;
      case 'watchOff':
        if (settings.watchEnabled) {
          settings.watchEnabled = false;
          saveSettings(); applyWatcher(); syncWatchControls();
          log('Remote: watching off');
        }
        break;
      case 'markRead': // phone opened the Mentions tab
        unreadMen = 0;
        updateMenBadge();
        break;
      default:
        break;
    }
  }

  // Elect the single tab that owns the remote. Returns true if THIS tab is the
  // leader after the call. Coordination is a shared localStorage record; the
  // on-target (sending) tab is preferred, and a stale record (dead/closed tab)
  // is always reclaimable. Returns false for standby tabs and stashes the
  // current leader's channel in remoteLeaderChannel for the status line.
  function claimRemoteLeadership() {
    let rec = null;
    try {
      const raw = localStorage.getItem(REMOTE_LEADER_KEY);
      if (raw) rec = JSON.parse(raw);
    } catch (e) { rec = null; } // corrupt/absent record ⇒ treat as no leader

    const now = Date.now();
    const stale = !rec || (now - rec.ts) > REMOTE_LEADER_STALE_MS;
    const iAmOnTarget = isOnTarget();

    // Decide whether I own the remote after this call.
    let iLead;
    if (stale) {
      iLead = true;                       // nobody holds a live claim — take it
    } else if (rec.id === TAB_ID) {
      iLead = true;                       // already the leader — keep it
    } else if (iAmOnTarget && !rec.onTarget) {
      iLead = true;                       // I'm the sending tab; strictly better — take over
    } else {
      iLead = false;                      // a fresh, equally-or-better leader exists — stand by
    }

    remoteLeader = iLead;
    if (iLead) {
      remoteLeaderChannel = null;
      try {
        localStorage.setItem(REMOTE_LEADER_KEY, JSON.stringify({
          id: TAB_ID,
          channel: currentChannel(),
          onTarget: iAmOnTarget,
          running: !!settings.running,
          ts: now,
        }));
      } catch (e) { /* storage full/blocked — still act as leader this tick */ }
    } else {
      remoteLeaderChannel = (rec && rec.channel) || null;
    }
    return iLead;
  }

  async function remoteSync() {
    if (!settings.remoteEnabled) return;
    // Only the elected leader tab talks to the single-slot server; standby tabs
    // skip the round trip entirely so they can't overwrite the leader's state.
    if (!claimRemoteLeadership()) {
      if (remoteOk !== null) remoteOk = null;
      updateRemoteStatus();
      return;
    }
    const port = Math.max(1, Math.min(65535, parseInt(settings.remotePort, 10) || 3300));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: buildRemoteState() }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (remoteOk !== true) { remoteOk = true; updateRemoteStatus(); log(`Remote: connected on port ${port}.`); }
      const cmds = d.commands || [];
      for (const cmd of cmds) applyRemoteCommand(cmd);
      updateStatus();
      // Having just acted on a command, push the resulting state straight back
      // so the phone's button confirms without waiting for the next tick.
      if (cmds.length) setTimeout(remoteSync, 120);
    } catch (e) {
      if (remoteOk !== false) { remoteOk = false; updateRemoteStatus(); }
    }
  }

  function applyRemote() {
    if (settings.remoteEnabled) {
      // 1s: it's a localhost round trip, so this is cheap and halves the worst
      // case wait before a phone command gets picked up.
      if (!remoteTimer) { remoteTimer = setInterval(remoteSync, 1000); remoteSync(); }
    } else if (remoteTimer) {
      clearInterval(remoteTimer);
      remoteTimer = null;
      remoteOk = null;
      updateRemoteStatus();
    }
  }

  // If this tab is the leader when it closes, expire the record immediately so a
  // surviving tab can take over on its next tick instead of waiting ~3s for the
  // claim to go stale. Best-effort: unload handlers can't be relied on fully.
  window.addEventListener('beforeunload', () => {
    try {
      const raw = localStorage.getItem(REMOTE_LEADER_KEY);
      if (!raw) return;
      const rec = JSON.parse(raw);
      if (rec && rec.id === TAB_ID) localStorage.removeItem(REMOTE_LEADER_KEY);
    } catch (e) { /* nothing we can do on the way out */ }
  });

  function updateRemoteStatus() {
    if (!ui.remStatus) return;
    if (!settings.remoteEnabled) { ui.remStatus.textContent = 'Off'; return; }
    if (!remoteLeader) {
      // Another tab owns the remote; we're deliberately silent so we don't
      // overwrite its state on the phone.
      const who = remoteLeaderChannel ? `@${remoteLeaderChannel}` : 'another';
      ui.remStatus.innerHTML = `Standby — ${who} tab is the active remote`;
      return;
    }
    ui.remStatus.innerHTML = remoteOk
      ? `Connected — open <b>http://&lt;this-pc-ip&gt;:${settings.remotePort}</b> on your phone`
      : `Waiting for server on port ${settings.remotePort} — run: node server.js`;
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
        // Sanitise restored extra senders, and never auto-start any of them off a
        // restore (mirrors main running:false above) so nothing fires unexpectedly.
        normalizeExtraSenders();
        settings.extraSenders.forEach((s) => { s.running = false; });
        saveSettings();
        applySettingsToUI(); // rebuilds the extra-sender cards + runtime via renderExtras()
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
      const scopeTxt = settings.watchScope === 'target'
        ? `only on the target channel (${targetChannel() ? `@${targetChannel()}` : 'none set'})`
        : `across all open channels`;
      lines.push(`Watching ${scopeTxt} for ${settings.watchBareName ? `@${wn} OR bare "${wn}"` : `@${wn}`} — mentions/replies go to the Mentions tab${settings.watchSound ? ' with a beep' : ' (no sound)'}.`);
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

    // $CHAT 24h-low monitor.
    if (settings.chatMonitor) {
      lines.push(targetChannel() === 'shoovy'
        ? `Alerting on new $CHAT 24h lows (needs the remote server running).`
        : `$CHAT monitor is on but only works when the target channel is shoovy.`);
    }

    // Extra senders.
    if (settings.extraSenders.length) {
      const running = settings.extraSenders.filter((s) => s.running).length;
      lines.push(`+ ${settings.extraSenders.length} extra sender${settings.extraSenders.length === 1 ? '' : 's'}, ${running} running.`);
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
  // Cross-tab live sync: when another tab captures a mention it writes the shared
  // store, which fires a 'storage' event HERE (storage events never fire in the
  // tab that made the change). Reload our list from disk and repaint so every tab
  // shows the union. We bump the unread badge for genuinely new records, but do
  // NOT beep — the beep belongs to the tab that actually captured the mention.
  function onMentionsStorage(e) {
    if (e.key !== MEN_KEY) return;
    if (!ui || !ui.mentions) return;
    const prevIds = new Set(mentionLog.map(mentionId));
    mentionLog = loadMentions();
    ui.mentions.textContent = '';
    for (const r of mentionLog) renderMention(r);
    menTotal = mentionLog.length;
    let gained = 0;
    for (const r of mentionLog) if (!prevIds.has(mentionId(r))) gained++;
    if (gained > 0 && activeTab !== 'men') unreadMen += gained;
    updateMenBadge();
    updateWatchStatus();
  }

  function boot() {
    injectStyles();
    buildPanel();
    window.addEventListener('storage', onMentionsStorage);
    applyWatcher();
    applyRemote();
    if (settings.running) {
      // Resume after navigation/reload if it was left running.
      scheduleNext();
      scheduleSecond();
      ensureTick();
      syncControls();
    }
    // Resume any extra senders that were left running, independently of the main.
    let anyExtraRunning = false;
    for (const s of settings.extraSenders) {
      if (s.running) { scheduleExtra(s); anyExtraRunning = true; }
    }
    if (anyExtraRunning) ensureTick();
  }

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
