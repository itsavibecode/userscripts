// ==UserScript==
// @name         Kick Chat Cleaner
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.1.0
// @description  Hide emote-only chat messages and collapse duplicate messages (keeping the original) on kick.com.
// @author       itsavibecode
// @match        https://kick.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @noframes
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/kick-chat-cleaner
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-chat-cleaner/kick-chat-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-chat-cleaner/kick-chat-cleaner.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Settings (toggle via the Tampermonkey menu on the kick.com tab)     *
   * ------------------------------------------------------------------ */
  const store = {
    get(key, def) {
      try { return GM_getValue(key, def); } catch (_) { return def; }
    },
    set(key, val) {
      try { GM_setValue(key, val); } catch (_) {}
    },
  };

  const cfg = {
    // Hide messages whose content is only emotes (and whitespace), no text.
    hideEmoteOnly: store.get('hideEmoteOnly', true),
    // Collapse duplicate messages, keeping the first (original) occurrence.
    hideDuplicates: store.get('hideDuplicates', true),
    // When deciding if two messages are duplicates, also require the same author.
    // false  -> copypasta from different users is also collapsed (classic spam dedupe)
    // true   -> only the same user repeating themselves is collapsed
    duplicatesPerUser: store.get('duplicatesPerUser', false),
    // How many recent (kept) messages to remember when checking for duplicates.
    duplicateWindow: store.get('duplicateWindow', 300),
    // Remove nodes from the DOM (true) instead of just visually hiding them (false).
    // Hiding is safer against framework re-renders; removing frees more memory.
    removeFromDom: store.get('removeFromDom', false),
  };

  /* ------------------------------------------------------------------ *
   * Message-node helpers                                                *
   * ------------------------------------------------------------------ */

  // A chat message entry can be matched a few different ways depending on how
  // Kick has shipped the chat that day. Try the most specific first.
  const ENTRY_SELECTORS = [
    '[data-chat-entry]',
    '[data-index] .chat-entry',
    '.chat-entry',
    '[class*="chatMessage"]',
  ];

  function isChatEntry(node) {
    if (!(node instanceof HTMLElement)) return false;
    return ENTRY_SELECTORS.some((sel) => node.matches && node.matches(sel));
  }

  function findEntriesWithin(node) {
    if (!(node instanceof HTMLElement)) return [];
    if (isChatEntry(node)) return [node];
    const out = [];
    for (const sel of ENTRY_SELECTORS) {
      const found = node.querySelectorAll ? node.querySelectorAll(sel) : [];
      if (found.length) { out.push(...found); break; }
    }
    return out;
  }

  // Return {text, emoteCount, author} for a message entry.
  // Text excludes username, timestamps, badges and emote alt-text.
  function describeEntry(entry) {
    // The content region: prefer an explicit content container, else the whole
    // entry with the identity/username stripped out.
    let contentRoot =
      entry.querySelector('.chat-entry-content') ||
      entry.querySelector('[class*="messageContent"]') ||
      entry;

    const clone = contentRoot.cloneNode(true);

    // Strip parts that are not the message body.
    const stripSelectors = [
      '.chat-message-identity',
      '.chat-entry-username',
      '[class*="identity"]',
      '[class*="username"]',
      '[class*="timestamp"]',
      '.chat-entry-badges',
      '[class*="badge"]',
      'time',
    ];
    stripSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Count and remove emotes so they don't count as "text".
    const emoteSelectors = [
      '.chat-emote',
      '[data-emote-name]',
      '[data-emote-id]',
      '.chat-emote-container img',
      'img[src*="emote"]',
    ];
    const emoteNames = [];
    let emoteCount = 0;
    const seenEmoteEls = new Set();
    emoteSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => {
        if (seenEmoteEls.has(el)) return;
        seenEmoteEls.add(el);
        emoteCount++;
        const name =
          el.getAttribute('data-emote-name') ||
          el.getAttribute('alt') ||
          el.getAttribute('title') ||
          (el.querySelector && el.querySelector('img') &&
            (el.querySelector('img').getAttribute('alt') || '')) ||
          '';
        emoteNames.push(name.trim());
        el.remove();
      });
    });

    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();

    // Author, for per-user duplicate checks.
    const authorEl =
      entry.querySelector('.chat-message-identity') ||
      entry.querySelector('.chat-entry-username') ||
      entry.querySelector('[class*="username"]');
    const author = authorEl ? (authorEl.textContent || '').trim() : '';

    return { text, emoteCount, emoteNames, author };
  }

  function isEmoteOnly(desc) {
    return desc.emoteCount > 0 && desc.text.length === 0;
  }

  function signature(desc) {
    // Duplicate key: normalized body text plus emote sequence, optionally scoped
    // to the author.
    const body = (desc.text + '  ' + desc.emoteNames.join(''))
      .toLowerCase()
      .trim();
    return cfg.duplicatesPerUser ? desc.author.toLowerCase() + '' + body : body;
  }

  /* ------------------------------------------------------------------ *
   * Hiding                                                              *
   * ------------------------------------------------------------------ */

  const HIDE_ATTR = 'data-kcc-hidden';

  function hideEntry(entry, reason) {
    if (entry.getAttribute(HIDE_ATTR)) return;
    entry.setAttribute(HIDE_ATTR, reason);
    if (cfg.removeFromDom) {
      entry.remove();
    } else {
      entry.style.setProperty('display', 'none', 'important');
    }
  }

  /* ------------------------------------------------------------------ *
   * Duplicate tracking (rolling window)                                 *
   * ------------------------------------------------------------------ */
  const seen = new Map();          // signature -> true
  const seenOrder = [];            // signatures in insertion order for eviction

  function rememberSignature(sig) {
    if (seen.has(sig)) return false; // already seen -> duplicate
    seen.set(sig, true);
    seenOrder.push(sig);
    while (seenOrder.length > cfg.duplicateWindow) {
      const evicted = seenOrder.shift();
      seen.delete(evicted);
    }
    return true; // first time
  }

  /* ------------------------------------------------------------------ *
   * Core processing                                                     *
   * ------------------------------------------------------------------ */
  const PROCESSED_ATTR = 'data-kcc-seen';

  function processEntry(entry) {
    if (!(entry instanceof HTMLElement)) return;
    if (entry.getAttribute(PROCESSED_ATTR)) return;
    entry.setAttribute(PROCESSED_ATTR, '1');

    let desc;
    try {
      desc = describeEntry(entry);
    } catch (_) {
      return;
    }

    // 1) Emote-only messages.
    if (cfg.hideEmoteOnly && isEmoteOnly(desc)) {
      hideEntry(entry, 'emote-only');
      return;
    }

    // 2) Duplicates. Skip empty/no-body messages so system rows aren't collapsed.
    if (cfg.hideDuplicates && (desc.text.length > 0 || desc.emoteCount > 0)) {
      const sig = signature(desc);
      const isFirst = rememberSignature(sig);
      if (!isFirst) {
        hideEntry(entry, 'duplicate');
        return;
      }
    }
  }

  function processAllExisting() {
    for (const sel of ENTRY_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) {
        found.forEach(processEntry);
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Observe the chat for new messages                                   *
   * ------------------------------------------------------------------ */
  let observer = null;

  function startObserving() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          findEntriesWithin(node).forEach(processEntry);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Sweep anything already on screen.
    processAllExisting();
  }

  startObserving();
  // Kick is an SPA; re-sweep on URL changes (channel switches) after re-render.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      seen.clear();
      seenOrder.length = 0;
      setTimeout(processAllExisting, 1500);
    }
  }, 1000);

  /* ------------------------------------------------------------------ *
   * Menu toggles                                                        *
   * ------------------------------------------------------------------ */
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    const toggle = (key, label) => {
      GM_registerMenuCommand(`${cfg[key] ? '✅' : '❌'} ${label}`, () => {
        cfg[key] = !cfg[key];
        store.set(key, cfg[key]);
        location.reload();
      });
    };
    toggle('hideEmoteOnly', 'Hide emote-only messages');
    toggle('hideDuplicates', 'Hide duplicate messages');
    toggle('duplicatesPerUser', 'Duplicates: per-user only');
    toggle('removeFromDom', 'Remove (instead of hide) nodes');
  }
  registerMenu();

  console.log('[Kick Chat Cleaner] active', {
    hideEmoteOnly: cfg.hideEmoteOnly,
    hideDuplicates: cfg.hideDuplicates,
    duplicatesPerUser: cfg.duplicatesPerUser,
  });
})();
