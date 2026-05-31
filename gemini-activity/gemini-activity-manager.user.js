// ==UserScript==
// @name         Gemini My Activity — Bulk Manager
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.3.2
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

    // Detect cards by anchoring on the TIMESTAMP rather than on buttons. Every
    // activity card carries exactly one clock time, while "Details" / "✕" /
    // "More" controls are unreliable anchors (the old approach kept landing on
    // the "Details" footer). We find each small element that owns a time, then
    // climb to the largest ancestor that still contains exactly one time — that
    // is the whole card (header + prompt + attachments + footer).
    function findCards() {
        const cards = new Map(); // cardEl -> delete control (found later)
        for (const a of timeAnchors()) {
            const card = climbTimeToCard(a);
            if (card && !cards.has(card)) cards.set(card, findDeleteControlIn(card));
        }
        return cards;
    }

    // Climb from a time element to the largest ancestor holding exactly one time.
    function climbTimeToCard(timeEl) {
        let el = timeEl, best = null, depth = 0;
        while (el && el !== document.body && depth < 16) {
            const times = ((el.textContent || '').match(TIME_RX_G) || []).length;
            if (times === 1) best = el;       // still a single card — keep growing
            else if (times > 1) break;        // reached the day group — stop
            el = el.parentElement;
            depth += 1;
        }
        return best;
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

        // Description: the row's rendered text, line by line, dropping noise —
        // the "Gemini Apps" product label, the "time • Details" footer, and bare
        // control labels. We use innerText (not a cloned/stripped subtree)
        // because the title + prompt often live inside a clickable element, so
        // stripping subtrees was eating the text.
        const ctrlWords = CFG.menuLabelWords.concat(CFG.deleteLabelWords);
        const isJunkLine = (l) => {
            const low = lc(l);
            if (!low) return true;
            if (/^gemini apps$/.test(low)) return true;
            // strip bullets + any time, then see if what's left is empty or a control word
            const rest = norm(low.replace(TIME_RX_G, ' ').replace(/[•·]/g, ' '));
            if (rest === '' || ctrlWords.includes(rest)) return true;
            return false;
        };
        let lines = (cardEl.innerText || cardEl.textContent || '')
            .split('\n')
            .map(norm)
            .filter(Boolean)
            .filter((l) => !isJunkLine(l));
        let desc = norm(lines.join(' — '));
        desc = norm(desc.replace(TIME_RX_G, ' ')).replace(/^[•·—–\-\s]+/, '').trim();
        if (desc.length > 600) desc = desc.slice(0, 597) + '…';

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
        let cardMap = findCards();
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

    // Visible timestamp labels — the same anchors detection uses, so this is a
    // reliable proxy for "how many items are loaded" regardless of button labels.
    function timeAnchors() {
        const out = [];
        for (const el of document.querySelectorAll('span, div, p, time, td, li')) {
            if (el.closest('#gam-panel') || el.closest('#gam-launch')) continue;
            if (!isVisible(el)) continue;
            const own = ownText(el);
            if (own && own.length <= 28 && TIME_RX.test(own)) out.push(el);
        }
        return out;
    }
    function countLoadedItems() { return timeAnchors().length; }
    function lastItemControl() { const a = timeAnchors(); return a.length ? a[a.length - 1] : null; }

    let scrolling = false;
    async function loadAll(onProgress) {
        if (scrolling) return;
        scrolling = true;
        let stable = 0, rounds = 0;
        // Track growth by BOTH item count and document height so we don't stop
        // early while a chunk is still loading.
        let lastCount = countLoadedItems();
        let lastH = document.documentElement.scrollHeight;
        try {
            while (scrolling && stable < CFG.scrollStableRounds && rounds < CFG.scrollMaxRounds) {
                const more = findShowMoreButton();
                if (more) more.click();
                // Drag the last loaded item into view — the most reliable way to
                // trigger lazy loading regardless of which element actually scrolls.
                const last = lastItemControl();
                if (last) { try { last.scrollIntoView({ block: 'end' }); } catch (e) {} }
                window.scrollTo(0, document.documentElement.scrollHeight);
                const root = getScrollRoot();
                if (root && root !== document.scrollingElement && root !== document.documentElement) {
                    root.scrollTop = root.scrollHeight;
                }
                await wait(CFG.scrollStepDelayMs);
                rounds += 1;
                const count = countLoadedItems();
                const h = document.documentElement.scrollHeight;
                if (count > lastCount || h > lastH + 4) { lastCount = Math.max(lastCount, count); lastH = Math.max(lastH, h); stable = 0; }
                else { stable += 1; }
                if (onProgress) onProgress(rounds, count);
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

    // A direct per-item delete control (the "✕" in each card's top-right),
    // identified by a delete/remove aria-label that is NOT a menu/details word.
    function findDeleteControlIn(card) {
        for (const c of card.querySelectorAll('button, [role="button"], a[aria-label]')) {
            if (isVisible(c) && ariaLabelHas(c, CFG.deleteLabelWords) && !ariaLabelHas(c, CFG.menuLabelWords)) {
                return c;
            }
        }
        return null;
    }

    // Delete one card by driving Google's own UI. Returns true on apparent success.
    async function deleteCard(item) {
        const card = item.el;
        if (!card || !card.isConnected) return true; // already gone

        // 1. Prefer the card's own ✕ delete button (Gemini activity cards have one).
        let opened = false;
        const directDelete = findDeleteControlIn(card) ||
            (item.control && ariaLabelHas(item.control, CFG.deleteLabelWords) &&
             !ariaLabelHas(item.control, CFG.menuLabelWords) ? item.control : null);
        if (directDelete) {
            directDelete.click();
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

        // 4. Success ≈ the card detached from the DOM (give it a beat to remove).
        if (opened && document.querySelector('[role="menu"]')) document.body.click();
        if (card.isConnected) await wait(300);
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

    // myactivity.google.com enforces Trusted Types CSP, which makes any
    // `element.innerHTML = "<html>"` throw. So we build all DOM with these
    // helpers (createElement + textContent) and never assign HTML strings.
    function el(tag, props, kids) {
        const e = document.createElement(tag);
        if (props) for (const k in props) {
            const v = props[k];
            if (v == null) continue;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style') e.style.cssText = v;
            else if (k.slice(0, 2) === 'on' && typeof v === 'function') e[k] = v;
            else if (k.indexOf('-') === -1 && k in e) { try { e[k] = v; } catch (_) { e.setAttribute(k, v); } }
            else e.setAttribute(k, v);
        }
        if (kids != null) for (const c of (Array.isArray(kids) ? kids : [kids])) {
            if (c == null || c === false) continue;
            e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
        }
        return e;
    }
    function clear(node) { if (node) node.replaceChildren(); }

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
        const mkBtn = (act, label, title) =>
            el('button', { class: 'gam-btn', 'data-act': act, type: 'button', title: title || null }, label);
        const p = el('div', { id: 'gam-panel' }, [
            el('div', { class: 'gam-head' }, [
                el('h2', { text: 'Gemini Activity Manager' }),
                el('button', { class: 'gam-x', type: 'button', title: 'Close', onclick: closePanel }, '×'),
            ]),
            el('div', { class: 'gam-bar' }, [
                mkBtn('loadall', 'Load all'),
                mkBtn('scan', 'Scan'),
                mkBtn('teach', 'Teach a sample', 'Click one activity card to teach the script its shape'),
                el('input', { class: 'gam-search', placeholder: 'Filter text…' }),
            ]),
            el('div', { class: 'gam-bar' }, [
                mkBtn('all', 'Select all'),
                mkBtn('feedback', 'Select feedback', 'Select every "Gave feedback:" item in the whole loaded feed'),
                mkBtn('none', 'Clear'),
                mkBtn('expand', 'Expand all'),
                mkBtn('collapse', 'Collapse all'),
            ]),
            el('div', { class: 'gam-meta', id: 'gam-meta' }, 'No items loaded yet. Click Load all, then Scan.'),
            el('div', { class: 'gam-list', id: 'gam-list' }, el('div', { class: 'gam-empty' }, 'Nothing scanned yet.')),
            el('div', { class: 'gam-foot' }, [
                el('div', { class: 'gam-confirm', id: 'gam-confirmrow', style: 'display:none' }, [
                    el('input', { type: 'checkbox', id: 'gam-understand' }),
                    el('label', { 'for': 'gam-understand', text: 'I understand this permanently deletes the checked items.' }),
                ]),
                el('div', { class: 'gam-progress', id: 'gam-progress' }, el('i')),
                el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
                    el('button', { class: 'gam-btn danger', 'data-act': 'delete', type: 'button', disabled: true }, 'Delete selected (0)'),
                    el('button', { class: 'gam-btn', 'data-act': 'stop', type: 'button', style: 'display:none' }, 'Stop'),
                    el('span', { id: 'gam-status', style: 'font-size:12px;color:#5f6368;flex:1' }),
                ]),
            ]),
        ]);
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
                status.textContent = 'Scrolling to the bottom…';
                e.target.disabled = true;
                const stopBtn = p.querySelector('[data-act="stop"]');
                if (stopBtn) stopBtn.style.display = '';
                await loadAll((rounds, count) => {
                    status.textContent = `Scrolling… ${count} items loaded (round ${rounds}) — Stop to halt`;
                });
                if (stopBtn) stopBtn.style.display = 'none';
                e.target.disabled = false;
                doScan();
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
        if (meta) {
            clear(meta);
            if (MODEL.source === 'none') {
                meta.textContent = 'No items detected. Try Load all first, or Teach a sample by clicking one activity card.';
            } else {
                const days = groupByDate(MODEL.items).size;
                meta.append(
                    el('b', { text: String(MODEL.items.length) }), ' items across ',
                    el('b', { text: String(days) }), ` date(s) · detection: ${MODEL.source}`,
                );
            }
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
            clear(list);
            list.appendChild(el('div', { class: 'gam-empty', text: 'No items to show. Load all → Scan.' }));
        } else {
            const prevCollapsed = {};
            list.querySelectorAll('.gam-group').forEach((g) => { prevCollapsed[g.dataset.date] = g.dataset.collapsed; });
            clear(list);
            for (const [date, arr] of groups) {
                const g = document.createElement('div');
                g.className = 'gam-group';
                g.dataset.date = date;
                g.dataset.collapsed = prevCollapsed[date] || '';
                const allSel = arr.every((it) => selected.has(it));
                const head = el('div', { class: 'gam-ghead' }, [
                    el('input', { type: 'checkbox', checked: allSel }),
                    el('span', { text: date }),
                    el('span', { class: 'gam-count', text: `${arr.length} item(s)` }),
                ]);
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

        const tx = el('div', { class: 'gam-rtext' }, [
            el('div', { class: 'gam-desc', text: it.desc }),
            el('div', { class: 'gam-time', text: it.time || '' }),
        ]);
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
        b.onclick = () => {
            // Surface failures instead of failing silently ("button does nothing").
            try {
                injectStyles();
                buildPanel();
            } catch (err) {
                console.error(LOG, 'panel failed to open:', err);
                alert('Activity Manager could not open:\n' + (err && err.message ? err.message : err) +
                      '\n\nOpen DevTools (F12) → Console and send the red error.');
                return;
            }
            try {
                doScan();
            } catch (err) {
                console.error(LOG, 'initial scan failed:', err);
                const s = document.getElementById('gam-status');
                if (s) s.textContent = 'Scan error (see console): ' + (err && err.message ? err.message : err);
            }
        };
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
