// ==UserScript==
// @name         Kick Chat Cleaner
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.3.1
// @description  Remove emote-only messages, duplicate messages (keeping the original), and messages matching custom phrases from kick.com chat. Filtered at the WebSocket layer so nothing leaves a gap. Draggable, resizable, collapsible GUI with live counters.
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
    // false -> copypasta from different users also collapses (spam dedupe)
    // true  -> only the same user repeating themselves collapses
    duplicatesPerUser: store.get('duplicatesPerUser', false),
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
    const content = payload.content;
    const username = payload.sender && payload.sender.username;

    if (cfg.hidePhrases && matchesPhrase(content)) { stats.phrase++; updatePanel(); return true; }
    if (cfg.hideEmoteOnly && isEmoteOnly(content)) { stats.emote++; updatePanel(); return true; }
    if (cfg.hideDuplicates && isDuplicate(content, username)) { stats.dupe++; updatePanel(); return true; }
    return false;
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
  let panel = null;
  const els = {};

  const css = `
    #kcc-panel { position: fixed; z-index: 2147483000; top: 96px; right: 16px;
      width: 226px; font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #e9e9ee; background: #16161b; border: 1px solid #2a2a33;
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
      display: flex; flex-direction: column; overflow: hidden;
      resize: both; min-width: 190px; min-height: 88px; max-width: 560px; max-height: 92vh; }
    #kcc-panel.min { resize: none; min-height: 0; height: auto !important; }
    #kcc-panel * { box-sizing: border-box; }
    #kcc-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      cursor: move; border-bottom: 1px solid #2a2a33; user-select: none; flex: 0 0 auto; }
    #kcc-dot { width: 8px; height: 8px; border-radius: 50%; background: #53d769; flex: 0 0 auto; }
    #kcc-dot.off { background: #7a7a85; }
    #kcc-title { font-weight: 600; font-size: 12px; flex: 1 1 auto; white-space: nowrap; }
    #kcc-min { cursor: pointer; opacity: .7; padding: 0 4px; font-size: 14px; }
    #kcc-min:hover { opacity: 1; }
    #kcc-body { padding: 8px 10px 10px; flex: 1 1 auto; overflow-y: auto; min-height: 0; }
    .kcc-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; }
    .kcc-row label { cursor: pointer; user-select: none; }
    .kcc-sw { position: relative; width: 32px; height: 18px; flex: 0 0 auto; }
    .kcc-sw input { opacity: 0; width: 0; height: 0; }
    .kcc-sl { position: absolute; inset: 0; background: #3a3a44; border-radius: 999px; transition: .15s; cursor: pointer; }
    .kcc-sl::before { content: ""; position: absolute; height: 14px; width: 14px; left: 2px; top: 2px;
      background: #fff; border-radius: 50%; transition: .15s; }
    .kcc-sw input:checked + .kcc-sl { background: #53a2ff; }
    .kcc-sw input:checked + .kcc-sl::before { transform: translateX(14px); }
    .kcc-sub { padding-left: 12px; opacity: .95; }
    .kcc-sub label { font-size: 11px; }
    .kcc-num { width: 58px; background: #23232b; border: 1px solid #3a3a44; color: #e9e9ee;
      border-radius: 5px; padding: 2px 4px; font: inherit; }
    #kcc-phrases { width: 100%; height: 58px; resize: vertical; margin-top: 4px;
      background: #23232b; border: 1px solid #3a3a44; color: #e9e9ee; border-radius: 6px;
      padding: 5px 6px; font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; }
    #kcc-phrases::placeholder { color: #6b6b76; }
    .kcc-hr { border: 0; border-top: 1px solid #23232b; margin: 8px 0 4px; }
    #kcc-stats { margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a33;
      display: flex; gap: 6px; text-align: center; }
    #kcc-stats > div { flex: 1; }
    #kcc-stats b { display: block; font-size: 15px; color: #fff; }
    #kcc-stats span { font-size: 9px; opacity: .6; text-transform: uppercase; letter-spacing: .03em; }
    #kcc-panel.min #kcc-body { display: none; }
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
    const lab = el('label', { text: label, for: id });
    const row = el('div', { class: 'kcc-row' + (sub ? ' kcc-sub' : '') }, [lab, sw]);
    return { row, inp };
  }

  function statCell(labelText, ref) {
    const b = el('b', { text: '0' });
    els[ref] = b;
    return el('div', {}, [b, el('span', { text: labelText })]);
  }

  function buildPanel() {
    if (panel || !document.body) return;
    document.head.appendChild(el('style', { text: css }));

    // Header
    els.dot = el('span', { id: 'kcc-dot', class: cfg.enabled ? '' : 'off' });
    const min = el('span', { id: 'kcc-min', text: cfg.minimized ? '+' : '–' });
    const head = el('div', { id: 'kcc-head' }, [
      els.dot,
      el('span', { id: 'kcc-title', text: 'Chat Cleaner' }),
      min,
    ]);

    // Toggles
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
        statCell('Emote', 'emoteN'),
        statCell('Dupes', 'dupeN'),
        statCell('Phrase', 'phraseN'),
      ]),
    ]);

    panel = el('div', { id: 'kcc-panel', class: cfg.minimized ? 'min' : '' }, [head, body]);
    document.body.appendChild(panel);

    if (cfg.panelX != null && cfg.panelY != null) {
      panel.style.left = cfg.panelX + 'px';
      panel.style.top = cfg.panelY + 'px';
      panel.style.right = 'auto';
    }
    // Restore saved size (only apply the height when expanded — a collapsed
    // panel sizes to its header).
    if (cfg.panelW) panel.style.width = cfg.panelW + 'px';
    if (cfg.panelH && !cfg.minimized) panel.style.height = cfg.panelH + 'px';

    // Persist size as the user drags the resize handle (debounced; skip the
    // collapsed state so we don't overwrite the real height).
    let sizeTimer;
    const ro = new ResizeObserver(() => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        if (cfg.minimized) return;
        const r = panel.getBoundingClientRect();
        cfg.panelW = Math.round(r.width);
        cfg.panelH = Math.round(r.height);
        store.set('panelW', cfg.panelW);
        store.set('panelH', cfg.panelH);
      }, 350);
    });
    ro.observe(panel);

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

    min.addEventListener('click', () => {
      cfg.minimized = !cfg.minimized;
      panel.classList.toggle('min', cfg.minimized);
      min.textContent = cfg.minimized ? '+' : '–';
      store.set('minimized', cfg.minimized);
      // Collapsed: let the panel shrink to its header. Expanded: restore height.
      if (cfg.minimized) panel.style.height = 'auto';
      else if (cfg.panelH) panel.style.height = cfg.panelH + 'px';
    });

    makeDraggable(panel, head, min);
    updatePanel();
  }

  function makeDraggable(elm, handle, ignore) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target === ignore) return;
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

  console.log('[Kick Chat Cleaner] v0.3.1 active (WebSocket filter installed at document-start)');
})();
