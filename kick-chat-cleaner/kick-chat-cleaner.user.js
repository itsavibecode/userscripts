// ==UserScript==
// @name         Kick Chat Cleaner
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.4.2
// @description  Remove emote-only messages, duplicate messages (keeping the original), and messages matching custom phrases from kick.com chat. Filtered at the WebSocket layer so nothing leaves a gap. Draggable, resizable, collapsible top-layer GUI with live counters and a slide-out log of what was removed.
// @author       itsavibecode
// @match        https://kick.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @noframes
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/kick-chat-cleaner
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-chat-cleaner/kick-chat-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-chat-cleaner/kick-chat-cleaner.user.js
// ==/UserScript==

/*
 * HOW THIS WORKS
 * --------------
 * Kick renders chat with a virtualized list that measures each row's height
 * once when it mounts and never reflows afterward. That means hiding or
 * shrinking a message's DOM node leaves a permanent blank gap where it was —
 * so the usual "querySelector + display:none" approach looks broken here.
 *
 * Instead we filter one level up: Kick receives chat over a Pusher-style
 * WebSocket, one frame per message:
 *     { event: "App\\Events\\ChatMessageEvent", data: "<json>", channel: "..." }
 * where JSON.parse(data) = { id, content, sender:{ username, ... }, ... } and
 * emotes live inside `content` as literal [emote:<id>:<name>] tokens.
 *
 * We wrap the socket's message handler at document-start (before Kick's client
 * grabs WebSocket) and simply DON'T forward chat frames we want to drop. Kick
 * never sees them, never renders them, and there is no gap. Any frame we can't
 * parse is always passed through untouched, so chat can never break.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Settings (persisted; toggle in the GUI or the Tampermonkey menu)    *
   * ------------------------------------------------------------------ */
  const store = {
    get(k, d) { try { const v = GM_getValue(k, d); return v === undefined ? d : v; } catch (_) { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch (_) {} },
  };

  const cfg = {
    enabled:           store.get('enabled', true),
    hideEmoteOnly:     store.get('hideEmoteOnly', true),
    hideDuplicates:    store.get('hideDuplicates', true),
    // true  -> only the same user repeating themselves collapses (default; matches
    //          the intuitive meaning of "duplicate" without nuking short reactions)
    // false -> copypasta from different users also collapses (aggressive spam dedupe)
    duplicatesPerUser: store.get('duplicatesPerUser', true),
    // How many recent kept messages to remember for duplicate checks.
    duplicateWindow:   store.get('duplicateWindow', 200),
    // Custom phrase blocklist.
    hidePhrases:       store.get('hidePhrases', false),
    phrasesText:       store.get('phrasesText', ''),
    // UI state.
    panelX:            store.get('panelX', null),
    panelY:            store.get('panelY', null),
    panelW:            store.get('panelW', null),
    panelH:            store.get('panelH', null),
    minimized:         store.get('minimized', false),
    logOpen:           store.get('logOpen', false),
    logTab:            store.get('logTab', 'emote'),
  };

  // Parsed, lowercased phrase list (rebuilt whenever phrasesText changes).
  let phrases = parsePhrases(cfg.phrasesText);
  function parsePhrases(text) {
    return String(text || '')
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }

  const stats = { emote: 0, dupe: 0, phrase: 0, seenChat: 0 };

  /* ------------------------------------------------------------------ *
   * Message classification                                              *
   * ------------------------------------------------------------------ */
  const EMOTE_TOKEN = /\[emote:\d+:[^\]]*\]/g;

  // Text left over once emotes are removed. Empty => the message was only emotes.
  function textWithoutEmotes(content) {
    return String(content == null ? '' : content).replace(EMOTE_TOKEN, '').replace(/\s+/g, ' ').trim();
  }

  // EMOTE_TOKEN carries the /g flag, so lastIndex must be reset before each
  // .test() or the result alternates between calls.
  function isEmoteOnly(content) {
    EMOTE_TOKEN.lastIndex = 0;
    const hasEmote = EMOTE_TOKEN.test(content);
    return hasEmote && textWithoutEmotes(content) === '';
  }

  // Content with [emote:id:name] replaced by the emote NAME, lowercased — so a
  // custom phrase like "kekw" matches the emote and "http" matches a link.
  function searchText(content) {
    return String(content == null ? '' : content)
      .replace(/\[emote:\d+:([^\]]*)\]/g, '$1')
      .toLowerCase();
  }

  function matchesPhrase(content) {
    if (!phrases.length) return false;
    const hay = searchText(content);
    for (let i = 0; i < phrases.length; i++) {
      if (hay.indexOf(phrases[i]) !== -1) return true;
    }
    return false;
  }

  // Rolling window of recently-kept message signatures.
  const seen = new Set();
  const order = [];

  function signature(content, username) {
    const body = String(content == null ? '' : content).replace(/\s+/g, ' ').trim().toLowerCase();
    return cfg.duplicatesPerUser ? (String(username || '').toLowerCase() + ' ' + body) : body;
  }

  function isDuplicate(content, username) {
    const sig = signature(content, username);
    if (seen.has(sig)) return true;
    seen.add(sig);
    order.push(sig);
    while (order.length > cfg.duplicateWindow) {
      seen.delete(order.shift());
    }
    return false;
  }

  // Decide whether to drop a raw WebSocket frame. Never throws.
  function shouldDropFrame(rawData) {
    if (!cfg.enabled) return false;
    if (typeof rawData !== 'string') return false;
    // Cheap pre-check before parsing every frame.
    if (rawData.indexOf('ChatMessageEvent') === -1) return false;
    let frame;
    try { frame = JSON.parse(rawData); } catch (_) { return false; }
    if (!frame || typeof frame.event !== 'string' || frame.event.indexOf('ChatMessageEvent') === -1) return false;

    let payload = frame.data;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) { return false; }
    }
    if (!payload || typeof payload.content !== 'string') return false;

    stats.seenChat++;
    updatePanel();
    const content = payload.content;
    const username = payload.sender && payload.sender.username;

    if (cfg.hidePhrases && matchesPhrase(content)) { stats.phrase++; recordRemoval('phrase', username, content); updatePanel(); return true; }
    if (cfg.hideEmoteOnly && isEmoteOnly(content)) { stats.emote++; recordRemoval('emote', username, content); updatePanel(); return true; }
    if (cfg.hideDuplicates && isDuplicate(content, username)) { stats.dupe++; recordRemoval('dupe', username, content); updatePanel(); return true; }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Removal log — identical removals from the same user are collapsed    *
   * into one entry with a count, most-recent activity first.            *
   * ------------------------------------------------------------------ */
  const LOG_CAP = 200; // distinct (user + message) entries kept per category
  const log = { emote: [], dupe: [], phrase: [] };
  const logIx = { emote: new Map(), dupe: new Map(), phrase: new Map() };

  // [emote:id:name] -> :name: so the log is human-readable.
  function displayContent(content) {
    return String(content == null ? '' : content).replace(/\[emote:\d+:([^\]]*)\]/g, ':$1:').trim();
  }

  function recordRemoval(cat, username, content) {
    const arr = log[cat], ix = logIx[cat];
    if (!arr) return;
    const u = String(username || '');
    const t = displayContent(content);
    const key = u.toLowerCase() + ' ' + t.toLowerCase();
    let hh = '', mm = '';
    try { const d = new Date(); hh = String(d.getHours()).padStart(2, '0'); mm = String(d.getMinutes()).padStart(2, '0'); } catch (_) {}
    const time = hh + ':' + mm;

    let e = ix.get(key);
    if (e) {
      // Seen before → bump the count and move it back to the top.
      e.count++;
      e.time = time;
      const i = arr.indexOf(e);
      if (i > 0) { arr.splice(i, 1); arr.unshift(e); }
    } else {
      e = { key, u, t, count: 1, time };
      arr.unshift(e);
      ix.set(key, e);
      while (arr.length > LOG_CAP) { const dropped = arr.pop(); ix.delete(dropped.key); }
    }
    scheduleLogRender(cat);
  }

  /* ------------------------------------------------------------------ *
   * WebSocket interception (prototype-level, installed at document-start)*
   * ------------------------------------------------------------------ */
  function wrapListener(listener) {
    if (typeof listener !== 'function') return listener;
    if (listener.__kccWrapped) return listener;
    const wrapped = function (ev) {
      try { if (ev && shouldDropFrame(ev.data)) return; } catch (_) {}
      return listener.apply(this, arguments);
    };
    wrapped.__kccWrapped = true;
    return wrapped;
  }

  try {
    const proto = window.WebSocket && window.WebSocket.prototype;
    if (proto) {
      // addEventListener('message', ...)
      const origAdd = proto.addEventListener;
      proto.addEventListener = function (type, listener, opts) {
        if (type === 'message') return origAdd.call(this, type, wrapListener(listener), opts);
        return origAdd.call(this, type, listener, opts);
      };
      // onmessage = ...
      const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
      if (desc && typeof desc.set === 'function') {
        Object.defineProperty(proto, 'onmessage', {
          configurable: true,
          enumerable: desc.enumerable,
          get() { return desc.get ? desc.get.call(this) : undefined; },
          set(fn) { desc.set.call(this, wrapListener(fn)); },
        });
      }
    }
  } catch (e) {
    console.error('[Kick Chat Cleaner] failed to install WebSocket hook', e);
  }

  /* ------------------------------------------------------------------ *
   * GUI                                                                 *
   * ------------------------------------------------------------------ */
  let panel = null, mainEl = null, logEl = null, logListEl = null;
  let activeTab = 'emote';
  const els = {};

  const css = `
    #kcc-panel { position: fixed; z-index: 2147483647; inset: auto; margin: 0; padding: 0;
      top: 96px; right: 16px;
      font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; color: #e9e9ee;
      display: flex; flex-direction: row; align-items: flex-start;
      background: transparent; border: 0; overflow: visible; }
    #kcc-panel:popover-open { display: flex; }
    #kcc-panel::backdrop { background: transparent; }
    #kcc-panel * { box-sizing: border-box; }

    #kcc-main { order: 2; width: 226px; background: #16161b; border: 1px solid #2a2a33;
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
      display: flex; flex-direction: column; overflow: hidden;
      resize: both; min-width: 190px; min-height: 88px; max-width: 560px; max-height: 92vh; }
    #kcc-main.min { resize: none; min-height: 0; height: auto !important; }
    #kcc-main.min #kcc-body { display: none; }
    #kcc-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      cursor: move; border-bottom: 1px solid #2a2a33; user-select: none; flex: 0 0 auto; }
    #kcc-dot { width: 8px; height: 8px; border-radius: 50%; background: #53d769; flex: 0 0 auto; }
    #kcc-dot.off { background: #7a7a85; }
    #kcc-title { font-weight: 600; font-size: 12px; flex: 1 1 auto; white-space: nowrap; }
    .kcc-hbtn { cursor: pointer; opacity: .7; padding: 0 4px; font-size: 13px; }
    .kcc-hbtn:hover { opacity: 1; }
    #kcc-logbtn.on { opacity: 1; color: #53a2ff; }
    #kcc-body { padding: 8px 10px 10px; flex: 1 1 auto; overflow-y: auto; min-height: 0; }

    .kcc-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; }
    .kcc-toggle { cursor: pointer; user-select: none; }
    .kcc-txt { flex: 1 1 auto; }
    .kcc-sw { position: relative; width: 32px; height: 18px; flex: 0 0 auto; cursor: pointer; }
    .kcc-sw input { opacity: 0; width: 0; height: 0; }
    .kcc-sl { position: absolute; inset: 0; background: #3a3a44; border-radius: 999px; transition: .15s; cursor: pointer; }
    .kcc-sl::before { content: ""; position: absolute; height: 14px; width: 14px; left: 2px; top: 2px;
      background: #fff; border-radius: 50%; transition: .15s; }
    .kcc-sw input:checked + .kcc-sl { background: #53a2ff; }
    .kcc-sw input:checked + .kcc-sl::before { transform: translateX(14px); }
    .kcc-sub { padding-left: 12px; opacity: .95; }
    .kcc-sub .kcc-txt, .kcc-sub label { font-size: 11px; }
    .kcc-num { width: 58px; background: #23232b; border: 1px solid #3a3a44; color: #e9e9ee;
      border-radius: 5px; padding: 2px 4px; font: inherit; }
    #kcc-phrases { width: 100%; height: 58px; resize: vertical; margin-top: 4px;
      background: #23232b; border: 1px solid #3a3a44; color: #e9e9ee; border-radius: 6px;
      padding: 5px 6px; font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; }
    #kcc-phrases::placeholder { color: #6b6b76; }
    .kcc-hr { border: 0; border-top: 1px solid #23232b; margin: 8px 0 4px; }
    #kcc-stats { margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a33;
      display: flex; gap: 6px; text-align: center; }
    #kcc-stats > div { flex: 1; border-radius: 6px; padding: 2px 0; }
    #kcc-stats > div.clk { cursor: pointer; }
    #kcc-stats > div.clk:hover { background: #20202a; }
    #kcc-stats b { display: block; font-size: 15px; color: #fff; }
    #kcc-stats span { font-size: 9px; opacity: .6; text-transform: uppercase; letter-spacing: .03em; }

    /* slide-out removed-message log */
    #kcc-log { order: 1; width: 0; overflow: hidden; transition: width .2s ease;
      background: #16161b; border: 1px solid #2a2a33; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.45); display: flex; flex-direction: column; max-height: 82vh; }
    #kcc-log:not(.open) { border-color: transparent; box-shadow: none; }
    #kcc-log.open { width: 292px; margin-right: 8px; }
    #kcc-log-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      border-bottom: 1px solid #2a2a33; flex: 0 0 auto; white-space: nowrap; }
    #kcc-log-title { font-weight: 600; flex: 1 1 auto; }
    #kcc-log-clear { cursor: pointer; opacity: .7; font-size: 11px; }
    #kcc-log-clear:hover { opacity: 1; color: #ff6b6b; }
    #kcc-tabs { display: flex; gap: 4px; padding: 6px 8px; flex: 0 0 auto; }
    .kcc-tab { flex: 1; text-align: center; padding: 4px 4px; border-radius: 6px; cursor: pointer;
      background: #20202a; font-size: 11px; user-select: none; white-space: nowrap; }
    .kcc-tab.active { background: #53a2ff; color: #fff; }
    #kcc-list { flex: 1 1 auto; overflow-y: auto; padding: 2px 8px 8px; min-height: 46px; }
    .kcc-le { padding: 3px 0; border-bottom: 1px solid #1e1e26; word-break: break-word; font-size: 11px; }
    .kcc-le .u { color: #7db8ff; font-weight: 600; }
    .kcc-le .ts { opacity: .4; font-size: 10px; float: right; margin-left: 6px; }
    .kcc-le .kcc-cnt { color: #ffb454; font-weight: 700; font-size: 10px; margin-left: 6px;
      background: #2a230f; border-radius: 999px; padding: 0 5px; white-space: nowrap; }
    #kcc-empty { opacity: .5; text-align: center; padding: 18px 8px; font-size: 11px; }
  `;

  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach((c) => n.appendChild(c));
    return n;
  }

  function toggleRow(id, label, checked, sub) {
    const inp = el('input', { type: 'checkbox', id });
    inp.checked = !!checked;
    const sl = el('span', { class: 'kcc-sl' });
    const sw = el('span', { class: 'kcc-sw' }, [inp, sl]);
    const txt = el('span', { class: 'kcc-txt', text: label });
    // The whole row is a <label for=id>, so a click anywhere on it — the text
    // OR the switch — toggles the checkbox.
    const row = el('label', { class: 'kcc-row kcc-toggle' + (sub ? ' kcc-sub' : ''), for: id }, [txt, sw]);
    return { row, inp };
  }

  function statCell(labelText, ref, cat) {
    const b = el('b', { text: '0' });
    els[ref] = b;
    const d = el('div', { class: cat ? 'clk' : '' }, [b, el('span', { text: labelText })]);
    if (cat) d.addEventListener('click', () => openLog(cat));
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Log drawer rendering                                                *
   * ------------------------------------------------------------------ */
  function logEntryNode(e) {
    const kids = [
      el('span', { class: 'ts', text: e.time }),
      el('span', { class: 'u', text: e.u + ': ' }),
      el('span', { class: 'm', text: e.t }),
    ];
    // Count badge — how many times this exact message was removed.
    if (e.count > 1) kids.push(el('span', { class: 'kcc-cnt', text: '×' + e.count }));
    return el('div', { class: 'kcc-le' }, kids);
  }

  function renderLog() {
    if (!logListEl) return;
    logListEl.textContent = '';
    const arr = log[activeTab] || [];
    if (!arr.length) {
      logListEl.appendChild(el('div', { id: 'kcc-empty', text: 'Nothing removed yet.' }));
      return;
    }
    for (let i = 0; i < arr.length; i++) logListEl.appendChild(logEntryNode(arr[i]));
  }

  // Called from recordRemoval for every drop. Entries are aggregated (with a
  // count), so we re-render the current tab — coalesced so a fast chat doesn't
  // rebuild the list on every single message.
  let renderPending = false;
  function scheduleLogRender(cat) {
    if (!logListEl || !logEl || !logEl.classList.contains('open') || cat !== activeTab) return;
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => { renderPending = false; renderLog(); }, 150);
  }

  function setTab(cat) {
    activeTab = cat;
    cfg.logTab = cat;
    store.set('logTab', cat);
    if (els.tabs) els.tabs.forEach((t) => t.el.classList.toggle('active', t.cat === cat));
    renderLog();
  }

  function toggleLog(force) {
    if (!logEl) return;
    const open = force != null ? force : !logEl.classList.contains('open');
    logEl.classList.toggle('open', open);
    if (els.logBtn) els.logBtn.classList.toggle('on', open);
    cfg.logOpen = open;
    store.set('logOpen', open);
    if (open) renderLog();
  }

  function openLog(cat) {
    if (cat && cat !== activeTab) setTab(cat);
    if (logEl && !logEl.classList.contains('open')) toggleLog(true);
    else renderLog();
  }

  function buildPanel() {
    if (panel || !document.body) return;
    document.head.appendChild(el('style', { text: css }));
    activeTab = log[cfg.logTab] ? cfg.logTab : 'emote';

    /* -------- settings column (main) -------- */
    els.dot = el('span', { id: 'kcc-dot', class: cfg.enabled ? '' : 'off' });
    els.logBtn = el('span', { id: 'kcc-logbtn', class: 'kcc-hbtn', text: '▤', title: 'Show removed-message log' });
    const min = el('span', { id: 'kcc-min', class: 'kcc-hbtn', text: cfg.minimized ? '+' : '–' });
    const head = el('div', { id: 'kcc-head' }, [
      els.dot,
      el('span', { id: 'kcc-title', text: 'Chat Cleaner' }),
      els.logBtn,
      min,
    ]);

    const on = toggleRow('kcc-enabled', 'Enabled', cfg.enabled);
    const emote = toggleRow('kcc-emote', 'Remove emote-only', cfg.hideEmoteOnly);
    const dupe = toggleRow('kcc-dupe', 'Remove duplicates', cfg.hideDuplicates);
    const per = toggleRow('kcc-per', 'Per-user only', cfg.duplicatesPerUser, true);

    const winInp = el('input', { type: 'number', class: 'kcc-num', min: '10', max: '2000', step: '10' });
    winInp.value = cfg.duplicateWindow;
    const winRow = el('div', { class: 'kcc-row kcc-sub' }, [el('label', { text: 'Duplicate memory' }), winInp]);

    const phraseTog = toggleRow('kcc-phrase', 'Remove custom phrases', cfg.hidePhrases);
    const phrasesTa = el('textarea', { id: 'kcc-phrases', placeholder: 'one phrase per line\ne.g. gamble\nfollow4follow' });
    phrasesTa.value = cfg.phrasesText;

    const body = el('div', { id: 'kcc-body' }, [
      on.row,
      el('hr', { class: 'kcc-hr' }),
      emote.row,
      dupe.row,
      per.row,
      winRow,
      el('hr', { class: 'kcc-hr' }),
      phraseTog.row,
      phrasesTa,
      el('div', { id: 'kcc-stats' }, [
        statCell('Scanned', 'seenN'),
        statCell('Emote', 'emoteN', 'emote'),
        statCell('Dupes', 'dupeN', 'dupe'),
        statCell('Phrase', 'phraseN', 'phrase'),
      ]),
    ]);

    mainEl = el('div', { id: 'kcc-main', class: cfg.minimized ? 'min' : '' }, [head, body]);

    /* -------- slide-out log drawer -------- */
    els.tabs = [];
    const tabsWrap = el('div', { id: 'kcc-tabs' });
    [['emote', 'Emote'], ['dupe', 'Dupes'], ['phrase', 'Phrase']].forEach(([cat, label]) => {
      const t = el('div', { class: 'kcc-tab' + (cat === activeTab ? ' active' : ''), text: label });
      t.addEventListener('click', () => setTab(cat));
      els.tabs.push({ el: t, cat });
      tabsWrap.appendChild(t);
    });
    const clearBtn = el('span', { id: 'kcc-log-clear', text: 'Clear' });
    logListEl = el('div', { id: 'kcc-list' });
    logEl = el('div', { id: 'kcc-log', class: cfg.logOpen ? 'open' : '' }, [
      el('div', { id: 'kcc-log-head' }, [el('span', { id: 'kcc-log-title', text: 'Removed' }), clearBtn]),
      tabsWrap,
      logListEl,
    ]);

    panel = el('div', { id: 'kcc-panel' }, [logEl, mainEl]);
    document.body.appendChild(panel);
    if (cfg.logOpen) els.logBtn.classList.add('on');
    renderLog();

    // Position is on the root; size is on the settings column.
    if (cfg.panelX != null && cfg.panelY != null) {
      panel.style.left = cfg.panelX + 'px';
      panel.style.top = cfg.panelY + 'px';
      panel.style.right = 'auto';
    }
    if (cfg.panelW) mainEl.style.width = cfg.panelW + 'px';
    if (cfg.panelH && !cfg.minimized) mainEl.style.height = cfg.panelH + 'px';

    // Persist the settings column's size as it's resized (debounced; skip while
    // collapsed so we don't overwrite the real height).
    let sizeTimer;
    const ro = new ResizeObserver(() => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        if (cfg.minimized) return;
        const r = mainEl.getBoundingClientRect();
        cfg.panelW = Math.round(r.width);
        cfg.panelH = Math.round(r.height);
        store.set('panelW', cfg.panelW);
        store.set('panelH', cfg.panelH);
      }, 350);
    });
    ro.observe(mainEl);

    // Stack above EVERYTHING via the browser top layer (popover); Kick's own
    // high-z-index overlays otherwise render over us and steal clicks.
    let usingPopover = false;
    try {
      if (typeof panel.showPopover === 'function') {
        panel.setAttribute('popover', 'manual');
        panel.showPopover();
        usingPopover = true;
      }
    } catch (_) { usingPopover = false; }

    // Survive the player going fullscreen/theater (its element enters the top
    // layer above us): re-assert ourselves.
    document.addEventListener('fullscreenchange', () => {
      if (!panel) return;
      if (usingPopover) {
        try { panel.hidePopover(); panel.showPopover(); } catch (_) {}
      } else {
        const host = document.fullscreenElement || document.body;
        if (panel.parentElement !== host) host.appendChild(panel);
      }
    });

    // Wiring
    on.inp.addEventListener('change', () => { cfg.enabled = on.inp.checked; store.set('enabled', cfg.enabled); els.dot.classList.toggle('off', !cfg.enabled); });
    emote.inp.addEventListener('change', () => { cfg.hideEmoteOnly = emote.inp.checked; store.set('hideEmoteOnly', cfg.hideEmoteOnly); });
    dupe.inp.addEventListener('change', () => { cfg.hideDuplicates = dupe.inp.checked; store.set('hideDuplicates', cfg.hideDuplicates); });
    per.inp.addEventListener('change', () => { cfg.duplicatesPerUser = per.inp.checked; store.set('duplicatesPerUser', cfg.duplicatesPerUser); seen.clear(); order.length = 0; });
    winInp.addEventListener('change', () => {
      let v = parseInt(winInp.value, 10); if (isNaN(v)) v = 200; v = Math.max(10, Math.min(2000, v));
      cfg.duplicateWindow = v; winInp.value = v; store.set('duplicateWindow', v);
    });
    phraseTog.inp.addEventListener('change', () => { cfg.hidePhrases = phraseTog.inp.checked; store.set('hidePhrases', cfg.hidePhrases); });
    phrasesTa.addEventListener('input', () => {
      cfg.phrasesText = phrasesTa.value;
      phrases = parsePhrases(cfg.phrasesText);
      store.set('phrasesText', cfg.phrasesText);
    });

    els.logBtn.addEventListener('click', () => toggleLog());
    clearBtn.addEventListener('click', () => { if (log[activeTab]) { log[activeTab].length = 0; logIx[activeTab].clear(); } renderLog(); });

    min.addEventListener('click', () => {
      cfg.minimized = !cfg.minimized;
      mainEl.classList.toggle('min', cfg.minimized);
      min.textContent = cfg.minimized ? '+' : '–';
      store.set('minimized', cfg.minimized);
      if (cfg.minimized) mainEl.style.height = 'auto';
      else if (cfg.panelH) mainEl.style.height = cfg.panelH + 'px';
    });

    makeDraggable(panel, head);
    updatePanel();
  }

  function makeDraggable(elm, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.kcc-hbtn')) return;
      dragging = true;
      const r = elm.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      elm.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(window.innerWidth - 40, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 24, ny));
      elm.style.left = nx + 'px'; elm.style.top = ny + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = elm.getBoundingClientRect();
      cfg.panelX = Math.round(r.left); cfg.panelY = Math.round(r.top);
      store.set('panelX', cfg.panelX); store.set('panelY', cfg.panelY);
    });
  }

  function updatePanel() {
    if (!els.emoteN) return;
    if (els.seenN) els.seenN.textContent = stats.seenChat;
    els.emoteN.textContent = stats.emote;
    els.dupeN.textContent = stats.dupe;
    els.phraseN.textContent = stats.phrase;
  }

  function ready(fn) {
    if (document.body) return fn();
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  ready(buildPanel);

  /* ------------------------------------------------------------------ *
   * Tampermonkey menu (mirrors the main GUI toggles)                    *
   * ------------------------------------------------------------------ */
  if (typeof GM_registerMenuCommand === 'function') {
    const mk = (key, label, after) => GM_registerMenuCommand((cfg[key] ? '✅ ' : '❌ ') + label, () => {
      cfg[key] = !cfg[key]; store.set(key, cfg[key]); if (after) after(); location.reload();
    });
    mk('enabled', 'Cleaner enabled');
    mk('hideEmoteOnly', 'Remove emote-only messages');
    mk('hideDuplicates', 'Remove duplicate messages');
    mk('duplicatesPerUser', 'Duplicates: per-user only');
    mk('hidePhrases', 'Remove custom phrases');
  }

  console.log('[Kick Chat Cleaner] v0.4.2 active (WebSocket filter installed at document-start)');
})();
