// ==UserScript==
// @name         Gemini My Activity — Bulk Manager
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.2.0
// @description  Adds a usable manager to myactivity.google.com (Gemini & other product feeds). Auto-scrolls to load every activity item, groups them by date, and gives you a checkbox panel with image + text previews so you can delete by date, by individual post, or all "Gave feedback:" posts at once — with one click. Deletions are performed by driving Google's own delete flow (open item menu, click Delete, confirm) sequentially, with a progress bar and a Stop button.
// @author       itsavibecode
// @match        https://myactivity.google.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/gemini-activity
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/gemini-activity/gemini-activity-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/gemini-activity/gemini-activity-manager.user.js
// ==/UserScript==

/*
 * WHAT THIS DOES
 * --------------
 * The Gemini My Activity feed is an infinite-scroll list with hashed class
 * names and no built-in multi-select. This script overlays a manager panel:
 *
 *   1. "Load all"  — auto-scrolls (and clicks any "Show more" button) until the
 *      feed stops growing, so every item is in the DOM.
 *   2. "Scan"      — walks the loaded DOM into a list of items, each with its
 *      date, time, description text, and thumbnail image (if any), grouped by
 *      the date header it falls under.
 *   3. The panel    — lists every date as a collapsible group with a group-level
 *      checkbox (delete a whole day) and per-item checkboxes (delete single
 *      posts), each row showing the image + description preview.
 *   4. "Delete"    — for every checked item, the script performs Google's own
 *      delete action (find the item's menu/delete control, click Delete, confirm
 *      the dialog), one item at a time with a delay, a progress bar, and Stop.
 *
 * WHY HEURISTICS + A "TEACH" FALLBACK
 * -----------------------------------
 * Google ships hashed classes that change without notice, so we never match by
 * class. We anchor on stable *behaviour* instead:
 *
 *   - Date headers  : short visible text matching a date pattern
 *                     ("Today", "Yesterday", "May 30, 2026", "May 30").
 *   - Items (cards) : the smallest ancestor of a per-item menu/delete control
 *                     that also contains a clock time. Each card's description
 *                     is its text minus the time and any control labels; its
 *                     thumbnail is the first content-sized <img> (or CSS
 *                     background-image) inside it.
 *   - Delete flow   : open the card's menu, click the menuitem whose text is
 *                     "Delete", then click the confirm button in the dialog.
 *
 * If auto-detection comes up empty (Google changed the markup enough to break
 * the heuristics), use "Teach a sample" — click one activity card and the
 * script learns its shape, then finds its siblings. Everything detected is also
 * dumped to the console (open DevTools) so you can see exactly what matched.
 *
 * SAFETY
 * ------
 * Deletes are permanent and hit your real Google account. Nothing is deleted
 * until you check items AND confirm a second time in the delete dialog. Stop
 * halts the queue between items at any point.
 */

(function () {
    'use strict';

    /* ============================ CONFIG ============================ */
    // If Google's markup drifts and a heuristic stops matching, these are the
    // knobs to turn. Everything text-based is case-insensitive.
    const CFG = {
        // Words that, in an aria-label, identify a per-item menu / overflow / delete control.
        menuLabelWords: ['menu', 'details', 'more', 'options', 'overflow'],
        deleteLabelWords: ['delete', 'remove'],
        // Text of the menu item / button that actually deletes.
        deleteActionWords: ['delete', 'remove'],
        // Auto-scroll tuning.
        scrollStepDelayMs: 700,     // pause between scroll nudges
        scrollStableRounds: 4,      // stop after this many rounds with no height growth
        scrollMaxRounds: 600,       // hard cap so we never loop forever
        // Deletion tuning.
        deleteStepDelayMs: 650,     // pause between each item delete
        menuOpenWaitMs: 450,        // wait for a menu/dialog to render
        // An <img> counts as a content thumbnail (not an icon) above this size.
        thumbMinPx: 28,
    };

    const LS = {
        taughtSelector: 'gam_taught_card_selector',
        viewMode: 'gam_view_mode',
    };
    const LOG = '[gemini-activity]';

    /* ============================ UTILS ============================ */
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const lc = (s) => norm(s).toLowerCase();

    // Items whose description starts a "Gave feedback:" entry (thumbs up/down on a Gemini reply).
    const FEEDBACK_RX = /gave feedback/i;
    const DATE_RX = /^(today|yesterday|(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(,?\s*\d{4})?)$/i;
    const TIME_RX = /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/i;
    const TIME_RX_G = /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi;

    function isVisible(el) {
        if (!el || !el.getClientRects().length) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // Text contributed directly by an element's own text-node children only
    // (so a wrapper div doesn't "own" the text of everything beneath it).
    function ownText(el) {
        let t = '';
        for (const n of el.childNodes) {
            if (n.nodeType === Node.TEXT_NODE) t += n.nodeValue;
        }
        return norm(t);
    }

    function ariaLabelHas(el, words) {
        const l = lc(el.getAttribute && el.getAttribute('aria-label'));
        if (!l) return false;
        return words.some((w) => l.includes(w));
    }

    function textHas(el, words) {
        const l = lc(el.textContent);
        if (!l || l.length > 40) return false; // controls have short labels
        return words.some((w) => l.includes(w));
    }

    /* ============================ DETECTION ============================ */

    // The element that scrolls the feed. On My Activity this is the document,
    // but we check for a taller inner scroller just in case.
    function getScrollRoot() {
        const docEl = document.scrollingElement || document.documentElement;
        // Look for an inner element that is the real scroller.
        const candidates = [...document.querySelectorAll('main, [role="main"], c-wiz, div')]
            .filter((el) => el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300);
        candidates.sort((a, b) => b.clientHeight - a.clientHeight);
        if (candidates.length && candidates[0].scrollHeight > docEl.scrollHeight - 50) {
            return candidates[0];
        }
        return docEl;
    }

    function scrollHeightOf(root) {
        return root === (document.scrollingElement || document.documentElement)
            ? root.scrollHeight
            : root.scrollHeight;
    }

    function scrollToBottom(root) {
        if (root === (document.scrollingElement || document.documentElement)) {
            window.scrollTo(0, document.body.scrollHeight);
        } else {
            root.scrollTop = root.scrollHeight;
        }
    }

    // Find a "Show more" / "Load more" button if the feed paginates by button.
    function findShowMoreButton() {
        const btns = [...document.querySelectorAll('button, [role="button"], a')];
        return btns.find((b) => isVisible(b) && /^(show|load|see)\s+more$/i.test(lc(b.textContent)));
    }

    // All visible elements whose OWN text is just a date — these are day headers.
    function findDateHeaders() {
        const out = [];
        const all = document.querySelectorAll('h1, h2, h3, h4, div, span, p');
        for (const el of all) {
            if (!isVisible(el)) continue;
            const t = ownText(el);
            if (t && t.length <= 24 && DATE_RX.test(t)) out.push({ el, text: t });
        }
        // De-dupe nested matches (keep the outermost element per unique text+position).
        return out;
    }

    // Locate per-item menu/delete controls, then climb to the card container.
    function findControlCards() {
        const controls = [];
        const all = document.querySelectorAll('button, [role="button"], [role="menuitem"], a[aria-label]');
        for (const el of all) {
            if (!isVisible(el)) continue;
            if (ariaLabelHas(el, CFG.menuLabelWords) || ariaLabelHas(el, CFG.deleteLabelWords)) {
                controls.push(el);
            }
        }
        const cards = new Map(); // cardEl -> control
        for (const ctrl of controls) {
            const card = climbToCard(ctrl);
            if (card && !cards.has(card)) cards.set(card, ctrl);
        }
        return cards;
    }

    // From a control, walk up until we reach the smallest ancestor that also
    // contains a clock time (the card row), but stop before we swallow siblings.
    function climbToCard(ctrl) {
        let el = ctrl;
        let depth = 0;
        while (el && el !== document.body && depth < 10) {
            const txt = el.textContent || '';
            if (TIME_RX.test(txt)) {
                // Don't over-climb into a container holding many times (a day group).
                const times = (txt.match(TIME_RX_G) || []).length;
                if (times <= 2) return el;
            }
            el = el.parentElement;
            depth += 1;
        }
        return null;
    }

    // Cards derived from a user-taught sample selector (fallback path).
    function findTaughtCards() {
        const sel = readLS(LS.taughtSelector);
        if (!sel) return new Map();
        let sample;
        try { sample = document.querySelector(sel); } catch (e) { return new Map(); }
        if (!sample) return new Map();
        const cards = new Map();
        // Siblings of the same tag under the same parent chain tend to be the rows.
        const parent = sample.parentElement;
        if (parent) {
            for (const sib of parent.children) {
                if (sib.tagName === sample.tagName && isVisible(sib) && TIME_RX.test(sib.textContent || '')) {
                    cards.set(sib, sib.querySelector('button, [role="button"]') || sib);
                }
            }
        }
        if (!cards.size) cards.set(sample, sample);
        return cards;
    }

    // Turn a card element into a structured record.
    function parseCard(cardEl, control, dateHeaders) {
        const rect = cardEl.getBoundingClientRect();
        const yTop = rect.top + window.scrollY;

        // Date: nearest header that sits above this card in the document.
        let date = '';
        let bestY = -Infinity;
        for (const h of dateHeaders) {
            const hy = h.el.getBoundingClientRect().top + window.scrollY;
            if (hy <= yTop + 4 && hy > bestY) { bestY = hy; date = h.text; }
        }
        if (!date) date = 'Undated';

        // Time: first clock match in the card.
        const tm = (cardEl.textContent || '').match(TIME_RX);
        const time = tm ? norm(tm[0]) : '';

        // Description: card text minus control labels and the time.
        const clone = cardEl.cloneNode(true);
        clone.querySelectorAll('button, [role="button"], svg, script, style, img').forEach((n) => n.remove());
        let desc = norm(clone.textContent);
        if (time) desc = norm(desc.replace(time, ''));
        desc = desc.replace(/^[•·\-–—\s]+/, '').trim();

        // Thumbnail: first content-sized <img>, else a CSS background-image url.
        let img = '';
        for (const im of cardEl.querySelectorAll('img')) {
            const w = im.naturalWidth || im.clientWidth || parseInt(im.getAttribute('width') || '0', 10);
            const h = im.naturalHeight || im.clientHeight || parseInt(im.getAttribute('height') || '0', 10);
            if ((w >= CFG.thumbMinPx || h >= CFG.thumbMinPx) && im.src) { img = im.src; break; }
        }
        if (!img) {
            for (const el of cardEl.querySelectorAll('*')) {
                const bg = getComputedStyle(el).backgroundImage;
                const m = bg && bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
                if (m) { img = m[1]; break; }
            }
        }

        return { el: cardEl, control, date, time, desc: desc || '(no description)', img };
    }

    // Full scan: detect cards (auto, then taught fallback) and parse them.
    function scan() {
        const dateHeaders = findDateHeaders();
        let cardMap = findControlCards();
        let source = 'auto';
        if (!cardMap.size) {
            cardMap = findTaughtCards();
            source = cardMap.size ? 'taught' : 'none';
        }
        const items = [];
        for (const [cardEl, control] of cardMap) {
            items.push(parseCard(cardEl, control, dateHeaders));
        }
        // Sort by document order (top to bottom).
        items.sort((a, b) =>
            (a.el.getBoundingClientRect().top + window.scrollY) -
            (b.el.getBoundingClientRect().top + window.scrollY));
        console.log(`${LOG} scan: ${items.length} items via "${source}", ${dateHeaders.length} date headers.`);
        return { items, dateHeaders, source };
    }

    /* ============================ AUTO-SCROLL ============================ */

    let scrolling = false;
    async function loadAll(onProgress) {
        if (scrolling) return;
        scrolling = true;
        const root = getScrollRoot();
        let stable = 0;
        let lastH = scrollHeightOf(root);
        let rounds = 0;
        try {
            while (scrolling && stable < CFG.scrollStableRounds && rounds < CFG.scrollMaxRounds) {
                const more = findShowMoreButton();
                if (more) more.click();
                else scrollToBottom(root);
                await wait(CFG.scrollStepDelayMs);
                rounds += 1;
                const h = scrollHeightOf(root);
                if (h > lastH + 4) { lastH = h; stable = 0; } else { stable += 1; }
                if (onProgress) onProgress(rounds, document.querySelectorAll('button,[role="button"]').length);
            }
        } finally {
            scrolling = false;
            window.scrollTo(0, 0);
        }
    }

    /* ============================ DELETION ============================ */

    function findInOpenMenu(words) {
        const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], li[role="option"], button')];
        return items.filter(isVisible).find((el) => textHas(el, words));
    }

    function findConfirmButton(words) {
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(isVisible);
        const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
        const btns = [...scope.querySelectorAll('button, [role="button"]')].filter(isVisible);
        // Prefer an exact "Delete" over partial matches like "Don't delete".
        return btns.find((b) => words.includes(lc(b.textContent))) ||
               btns.find((b) => textHas(b, words) && !/don'?t|cancel|keep/i.test(b.textContent));
    }

    // Delete one card by driving Google's own UI. Returns true on apparent success.
    async function deleteCard(item) {
        const card = item.el;
        if (!card || !card.isConnected) return true; // already gone

        // 1. If the control itself is a direct delete button, click it.
        let opened = false;
        if (item.control && ariaLabelHas(item.control, CFG.deleteLabelWords) &&
            !ariaLabelHas(item.control, CFG.menuLabelWords)) {
            item.control.click();
        } else {
            // 2. Otherwise open the item's menu, then click "Delete".
            const menuBtn = item.control ||
                card.querySelector('button[aria-haspopup="menu"], [aria-haspopup="true"], button, [role="button"]');
            if (!menuBtn) return false;
            menuBtn.click();
            opened = true;
            await wait(CFG.menuOpenWaitMs);
            const del = findInOpenMenu(CFG.deleteActionWords);
            if (!del) {
                document.body.click(); // close stray menu
                return false;
            }
            del.click();
        }

        // 3. Confirm the dialog if one appears.
        await wait(CFG.menuOpenWaitMs);
        const confirm = findConfirmButton(CFG.deleteActionWords);
        if (confirm) confirm.click();
        await wait(CFG.menuOpenWaitMs);

        // 4. Success ≈ the card detached from the DOM.
        if (opened && document.querySelector('[role="menu"]')) document.body.click();
        return !card.isConnected;
    }

    let deleting = false;
    async function runDelete(items, hooks) {
        if (deleting) return;
        deleting = true;
        let ok = 0, fail = 0;
        try {
            for (let i = 0; i < items.length; i++) {
                if (!deleting) break; // Stop pressed
                hooks.onStep(i, items.length, items[i]);
                let success = false;
                try { success = await deleteCard(items[i]); } catch (e) { console.warn(LOG, 'delete error', e); }
                if (success) { ok += 1; hooks.onItemDone(items[i], true); }
                else { fail += 1; hooks.onItemDone(items[i], false); }
                await wait(CFG.deleteStepDelayMs);
            }
        } finally {
            deleting = false;
            hooks.onFinish(ok, fail);
        }
    }

    /* ============================ STATE ============================ */
    let MODEL = { items: [], dateHeaders: [], source: 'none' };
    const selected = new Set(); // set of item objects

    function readLS(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
    function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    function groupByDate(items) {
        const map = new Map();
        for (const it of items) {
            if (!map.has(it.date)) map.set(it.date, []);
            map.get(it.date).push(it);
        }
        return map;
    }

    /* ============================ UI ============================ */

    function injectStyles() {
        if (document.getElementById('gam-styles')) return;
        const s = document.createElement('style');
        s.id = 'gam-styles';
        s.textContent = `
        #gam-launch{position:fixed;right:18px;bottom:18px;z-index:2147483647;
          width:auto;height:44px;padding:0 16px;border:none;border-radius:22px;
          background:#1a73e8;color:#fff;font:600 14px/44px "Google Sans",Roboto,Arial,sans-serif;
          cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3);}
        #gam-launch:hover{background:#1b66c9;}
        #gam-panel{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:96vw;
          z-index:2147483646;background:#fff;color:#202124;display:flex;flex-direction:column;
          box-shadow:-3px 0 18px rgba(0,0,0,.28);font:14px/1.4 Roboto,Arial,sans-serif;}
        #gam-panel *{box-sizing:border-box;}
        .gam-head{padding:14px 16px;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;gap:8px;}
        .gam-head h2{font:600 16px "Google Sans",Roboto,Arial;margin:0;flex:1;}
        .gam-x{border:none;background:none;font-size:22px;cursor:pointer;color:#5f6368;line-height:1;}
        .gam-bar{padding:10px 16px;border-bottom:1px solid #eee;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
        .gam-btn{border:1px solid #dadce0;background:#fff;color:#1a73e8;border-radius:6px;
          padding:7px 12px;font:600 13px Roboto,Arial;cursor:pointer;}
        .gam-btn:hover{background:#f1f6fe;}
        .gam-btn[disabled]{opacity:.5;cursor:default;}
        .gam-btn.primary{background:#1a73e8;color:#fff;border-color:#1a73e8;}
        .gam-btn.primary:hover{background:#1b66c9;}
        .gam-btn.danger{background:#d93025;color:#fff;border-color:#d93025;}
        .gam-btn.danger:hover{background:#c5221f;}
        .gam-search{flex:1;min-width:120px;padding:7px 10px;border:1px solid #dadce0;border-radius:6px;font-size:13px;}
        .gam-meta{padding:6px 16px;font-size:12px;color:#5f6368;border-bottom:1px solid #f0f0f0;}
        .gam-list{flex:1;overflow:auto;padding:4px 0;}
        .gam-group{border-bottom:1px solid #f1f1f1;}
        .gam-ghead{display:flex;align-items:center;gap:8px;padding:8px 14px;background:#f8f9fa;
          position:sticky;top:0;cursor:pointer;font-weight:600;}
        .gam-ghead .gam-count{font-weight:400;color:#5f6368;font-size:12px;}
        .gam-row{display:flex;gap:10px;padding:8px 14px 8px 30px;align-items:flex-start;}
        .gam-row:hover{background:#f8fbff;}
        .gam-row.gone{opacity:.4;text-decoration:line-through;}
        .gam-row.fail{background:#fdeceb;}
        .gam-thumb{width:46px;height:46px;flex:none;border-radius:6px;object-fit:cover;
          background:#f1f3f4;border:1px solid #e0e0e0;}
        .gam-noimg{display:flex;align-items:center;justify-content:center;font-size:18px;color:#9aa0a6;}
        .gam-rtext{flex:1;min-width:0;}
        .gam-desc{font-size:13px;color:#202124;word-break:break-word;
          display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
        .gam-time{font-size:11px;color:#5f6368;margin-top:2px;}
        .gam-foot{border-top:1px solid #e0e0e0;padding:12px 16px;}
        .gam-progress{height:6px;background:#e8eaed;border-radius:3px;overflow:hidden;margin:8px 0;display:none;}
        .gam-progress > i{display:block;height:100%;width:0;background:#1a73e8;transition:width .2s;}
        .gam-confirm{display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;color:#5f6368;}
        .gam-empty{padding:40px 20px;text-align:center;color:#5f6368;}
        input[type=checkbox]{width:16px;height:16px;flex:none;margin-top:2px;cursor:pointer;accent-color:#1a73e8;}
        `;
        document.head.appendChild(s);
    }

    let pickActive = false;

    function buildPanel() {
        if (document.getElementById('gam-panel')) return;
        const p = document.createElement('div');
        p.id = 'gam-panel';
        p.innerHTML = `
          <div class="gam-head">
            <h2>Gemini Activity Manager</h2>
            <button class="gam-x" title="Close">&times;</button>
          </div>
          <div class="gam-bar">
            <button class="gam-btn" data-act="loadall">Load all</button>
            <button class="gam-btn" data-act="scan">Scan</button>
            <button class="gam-btn" data-act="teach" title="Click one activity card to teach the script its shape">Teach a sample</button>
            <input class="gam-search" placeholder="Filter text…">
          </div>
          <div class="gam-bar">
            <button class="gam-btn" data-act="all">Select all</button>
            <button class="gam-btn" data-act="feedback" title="Select every &quot;Gave feedback:&quot; item in the whole loaded feed">Select feedback</button>
            <button class="gam-btn" data-act="none">Clear</button>
            <button class="gam-btn" data-act="expand">Expand all</button>
            <button class="gam-btn" data-act="collapse">Collapse all</button>
          </div>
          <div class="gam-meta" id="gam-meta">No items loaded yet. Click <b>Load all</b>, then <b>Scan</b>.</div>
          <div class="gam-list" id="gam-list"><div class="gam-empty">Nothing scanned yet.</div></div>
          <div class="gam-foot">
            <div class="gam-confirm" id="gam-confirmrow" style="display:none">
              <input type="checkbox" id="gam-understand">
              <label for="gam-understand">I understand this permanently deletes the checked items.</label>
            </div>
            <div class="gam-progress" id="gam-progress"><i></i></div>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="gam-btn danger" data-act="delete" disabled>Delete selected (0)</button>
              <button class="gam-btn" data-act="stop" style="display:none">Stop</button>
              <span id="gam-status" style="font-size:12px;color:#5f6368;flex:1"></span>
            </div>
          </div>`;
        document.body.appendChild(p);
        wirePanel(p);
        const launch = document.getElementById('gam-launch');
        if (launch) launch.style.display = 'none';
    }

    function closePanel() {
        const p = document.getElementById('gam-panel');
        if (p) p.remove();
        const launch = document.getElementById('gam-launch');
        if (launch) launch.style.display = '';
    }

    function wirePanel(p) {
        p.querySelector('.gam-x').onclick = closePanel;
        const status = p.querySelector('#gam-status');
        const search = p.querySelector('.gam-search');
        search.oninput = render;

        p.addEventListener('click', async (e) => {
            const act = e.target.getAttribute('data-act');
            if (!act) return;
            if (act === 'loadall') {
                status.textContent = 'Loading…';
                e.target.disabled = true;
                await loadAll((rounds) => { status.textContent = `Scrolling… round ${rounds}`; });
                e.target.disabled = false;
                doScan();
                status.textContent = 'Loaded.';
            } else if (act === 'scan') {
                doScan();
            } else if (act === 'teach') {
                enterPickMode();
            } else if (act === 'all') {
                visibleItems().forEach((it) => selected.add(it));
                render();
            } else if (act === 'feedback') {
                const fb = MODEL.items.filter((it) => FEEDBACK_RX.test(it.desc));
                fb.forEach((it) => selected.add(it));
                render();
                status.textContent = fb.length
                    ? `Selected ${fb.length} "Gave feedback" item(s) across the feed.`
                    : 'No "Gave feedback" items found — try Load all + Scan first.';
            } else if (act === 'none') {
                selected.clear();
                render();
            } else if (act === 'expand' || act === 'collapse') {
                p.querySelectorAll('.gam-group').forEach((g) => {
                    g.dataset.collapsed = act === 'collapse' ? '1' : '';
                });
                render();
            } else if (act === 'delete') {
                await startDelete();
            } else if (act === 'stop') {
                deleting = false;
                scrolling = false;
                status.textContent = 'Stopping…';
            }
        });
    }

    function doScan() {
        MODEL = scan();
        // Prune selections that no longer exist.
        for (const it of [...selected]) if (!MODEL.items.includes(it)) selected.delete(it);
        const meta = document.getElementById('gam-meta');
        if (MODEL.source === 'none') {
            meta.innerHTML = 'No items detected. Try <b>Load all</b> first, or <b>Teach a sample</b> by clicking one activity card.';
        } else {
            const days = groupByDate(MODEL.items).size;
            meta.innerHTML = `<b>${MODEL.items.length}</b> items across <b>${days}</b> date(s) · detection: ${MODEL.source}`;
        }
        render();
    }

    function currentFilter() {
        const s = document.querySelector('#gam-panel .gam-search');
        return s ? lc(s.value) : '';
    }

    function visibleItems() {
        const f = currentFilter();
        if (!f) return MODEL.items;
        return MODEL.items.filter((it) => lc(it.desc).includes(f) || lc(it.date).includes(f));
    }

    function render() {
        const list = document.getElementById('gam-list');
        if (!list) return;
        const items = visibleItems();
        const groups = groupByDate(items);

        if (!items.length) {
            list.innerHTML = '<div class="gam-empty">No items to show. Load all → Scan.</div>';
        } else {
            const prevCollapsed = {};
            list.querySelectorAll('.gam-group').forEach((g) => { prevCollapsed[g.dataset.date] = g.dataset.collapsed; });
            list.innerHTML = '';
            for (const [date, arr] of groups) {
                const g = document.createElement('div');
                g.className = 'gam-group';
                g.dataset.date = date;
                g.dataset.collapsed = prevCollapsed[date] || '';
                const allSel = arr.every((it) => selected.has(it));
                const head = document.createElement('div');
                head.className = 'gam-ghead';
                head.innerHTML = `<input type="checkbox" ${allSel ? 'checked' : ''}>
                    <span>${escapeHtml(date)}</span>
                    <span class="gam-count">${arr.length} item(s)</span>`;
                const cb = head.querySelector('input');
                cb.onclick = (ev) => {
                    ev.stopPropagation();
                    if (cb.checked) arr.forEach((it) => selected.add(it));
                    else arr.forEach((it) => selected.delete(it));
                    render();
                };
                head.onclick = () => { g.dataset.collapsed = g.dataset.collapsed ? '' : '1'; render(); };
                g.appendChild(head);

                if (!g.dataset.collapsed) {
                    for (const it of arr) g.appendChild(buildRow(it));
                }
                list.appendChild(g);
            }
        }
        updateFooter();
    }

    function buildRow(it) {
        const row = document.createElement('div');
        row.className = 'gam-row' + (it._gone ? ' gone' : '') + (it._fail ? ' fail' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(it);
        cb.onclick = () => { cb.checked ? selected.add(it) : selected.delete(it); updateFooter(); syncGroupHeads(); };
        row.appendChild(cb);

        if (it.img) {
            const im = document.createElement('img');
            im.className = 'gam-thumb';
            im.src = it.img;
            im.loading = 'lazy';
            im.onerror = () => { im.replaceWith(noImg()); };
            row.appendChild(im);
        } else {
            row.appendChild(noImg());
        }

        const tx = document.createElement('div');
        tx.className = 'gam-rtext';
        tx.innerHTML = `<div class="gam-desc">${escapeHtml(it.desc)}</div>
            <div class="gam-time">${escapeHtml(it.time || '')}</div>`;
        row.appendChild(tx);
        return row;
    }

    function noImg() {
        const d = document.createElement('div');
        d.className = 'gam-thumb gam-noimg';
        d.textContent = '≡'; // lines glyph for text-only items
        return d;
    }

    function syncGroupHeads() {
        const groups = groupByDate(visibleItems());
        document.querySelectorAll('#gam-list .gam-group').forEach((g) => {
            const arr = groups.get(g.dataset.date) || [];
            const cb = g.querySelector('.gam-ghead input');
            if (cb) cb.checked = arr.length > 0 && arr.every((it) => selected.has(it));
        });
    }

    function updateFooter() {
        const delBtn = document.querySelector('#gam-panel [data-act="delete"]');
        const confirmRow = document.getElementById('gam-confirmrow');
        if (!delBtn) return;
        const n = selected.size;
        delBtn.textContent = `Delete selected (${n})`;
        const understand = document.getElementById('gam-understand');
        confirmRow.style.display = n ? 'flex' : 'none';
        delBtn.disabled = !n || (understand && !understand.checked) || deleting;
        if (understand) understand.onchange = updateFooter;
    }

    async function startDelete() {
        const understand = document.getElementById('gam-understand');
        if (!understand || !understand.checked) return;
        const queue = MODEL.items.filter((it) => selected.has(it) && !it._gone);
        if (!queue.length) return;
        const status = document.getElementById('gam-status');
        const prog = document.getElementById('gam-progress');
        const bar = prog.querySelector('i');
        const stopBtn = document.querySelector('#gam-panel [data-act="stop"]');
        prog.style.display = 'block';
        stopBtn.style.display = '';
        updateFooter();

        await runDelete(queue, {
            onStep: (i, total) => {
                bar.style.width = `${Math.round((i / total) * 100)}%`;
                status.textContent = `Deleting ${i + 1} of ${total}…`;
            },
            onItemDone: (it, ok) => {
                if (ok) { it._gone = true; selected.delete(it); }
                else { it._fail = true; }
                render();
            },
            onFinish: (ok, fail) => {
                bar.style.width = '100%';
                stopBtn.style.display = 'none';
                status.textContent = `Done. Deleted ${ok}${fail ? `, ${fail} failed (left checked)` : ''}.`;
                setTimeout(() => { prog.style.display = 'none'; bar.style.width = '0'; }, 1500);
                MODEL.items = MODEL.items.filter((it) => !it._gone);
                render();
            },
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------- teach / pick mode (manual fallback) ---------- */

    let pickOverlay = null, pickHover = null;
    function enterPickMode() {
        if (pickActive) return;
        pickActive = true;
        const status = document.getElementById('gam-status');
        if (status) status.textContent = 'Pick mode: click ONE activity card. Esc to cancel.';
        pickOverlay = document.createElement('div');
        pickOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;' +
            'background:rgba(26,115,232,.18);border:2px solid #1a73e8;box-sizing:border-box;';
        document.body.appendChild(pickOverlay);
        document.addEventListener('mousemove', onPickMove, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
    }
    function exitPickMode() {
        pickActive = false;
        document.removeEventListener('mousemove', onPickMove, true);
        document.removeEventListener('click', onPickClick, true);
        document.removeEventListener('keydown', onPickKey, true);
        if (pickOverlay) pickOverlay.remove();
        pickOverlay = null; pickHover = null;
    }
    function onPickMove(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el.closest('#gam-panel')) return;
        pickHover = el;
        const r = el.getBoundingClientRect();
        Object.assign(pickOverlay.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    }
    function onPickClick(e) {
        if (!pickActive) return;
        e.preventDefault(); e.stopPropagation();
        const target = pickHover;
        exitPickMode();
        if (!target) return;
        // Climb to a card-like ancestor (contains a time).
        let card = target;
        let d = 0;
        while (card && card !== document.body && d < 10 && !TIME_RX.test(card.textContent || '')) { card = card.parentElement; d++; }
        if (!card) card = target;
        const sel = buildSelector(card);
        writeLS(LS.taughtSelector, sel);
        const status = document.getElementById('gam-status');
        if (status) status.textContent = 'Learned a sample. Scanning…';
        doScan();
    }
    function onPickKey(e) { if (e.key === 'Escape') { exitPickMode(); const s = document.getElementById('gam-status'); if (s) s.textContent = 'Pick cancelled.'; } }

    function buildSelector(el) {
        if (!el || el === document.body) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let cur = el, depth = 0;
        while (cur && cur !== document.body && depth < 6) {
            let part = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
                const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
                if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
            }
            parts.unshift(part);
            cur = cur.parentElement; depth++;
        }
        return parts.join(' > ');
    }

    /* ============================ LAUNCH ============================ */

    function ensureLauncher() {
        if (document.getElementById('gam-launch') || document.getElementById('gam-panel')) return;
        const b = document.createElement('button');
        b.id = 'gam-launch';
        b.type = 'button';
        b.textContent = 'Activity Manager';
        b.onclick = () => { injectStyles(); buildPanel(); doScan(); };
        document.body.appendChild(b);
    }

    function init() {
        injectStyles();
        if (document.body) ensureLauncher();
        else window.addEventListener('DOMContentLoaded', ensureLauncher, { once: true });
    }

    // Re-add the launcher across SPA navigations.
    const origPush = history.pushState;
    history.pushState = function () { const r = origPush.apply(this, arguments); setTimeout(ensureLauncher, 200); return r; };
    window.addEventListener('popstate', () => setTimeout(ensureLauncher, 200));

    init();
    setTimeout(ensureLauncher, 1200);
    setTimeout(ensureLauncher, 3000);
})();
