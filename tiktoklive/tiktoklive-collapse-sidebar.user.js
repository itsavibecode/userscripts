// ==UserScript==
// @name         TikTok LIVE — Collapse Left Sidebar
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.1.1
// @description  Adds a toggle button on TikTok LIVE pages that collapses the left navigation sidebar (TikTok logo, Discover LIVE, Go LIVE, Creator tools, Get Coins, Following list) to give the live video and chat more breathing room. Preference persists across sessions.
// @author       itsavibecode
// @match        https://www.tiktok.com/*
// @run-at       document-end
// @grant        none
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/tiktoklive
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/tiktoklive/tiktoklive-collapse-sidebar.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/tiktoklive/tiktoklive-collapse-sidebar.user.js
// ==/UserScript==

/*
 * Detection strategy
 * ------------------
 * TikTok styles its UI with hashed class names, so matching by class is
 * brittle. Instead we find the sidebar by structure:
 *
 *   1. Look for an element carrying a stable nav signal — `data-e2e^="nav-"`,
 *      a link to /foryou or /following, or visible text like "Get Coins" /
 *      "Discover LIVE".
 *   2. Walk up from that element until we find an ancestor whose bounding
 *      rect is the sidebar's shape: pinned to the left edge, narrow
 *      (60–380px), and tall (≥ half the viewport).
 *   3. If nothing matches, fall back to scanning every `<aside>` / `<nav>` /
 *      sticky-positioned element for that same shape.
 *   4. If automatic detection still fails, the user can shift-click the
 *      toggle button to enter pick mode and click the sidebar manually. The
 *      chosen element's CSS path is saved in localStorage and reused on
 *      future loads.
 */

(function () {
    'use strict';

    const STATE_KEY = 'ttlive_sidebar_collapsed';
    const PICKED_PATH_KEY = 'ttlive_sidebar_picked_selector';
    const HIDDEN_ATTR = 'data-ttlive-hidden';
    const LOG_PREFIX = '[ttlive-collapse]';

    function isLivePage() {
        return /\/live(\b|\/|\?|$)/.test(location.pathname + location.search);
    }

    function rectLooksLikeSidebar(rect) {
        return (
            rect &&
            rect.left <= 6 &&
            rect.width >= 56 &&
            rect.width <= 400 &&
            rect.height >= window.innerHeight * 0.45
        );
    }

    function walkUpForSidebarShape(start) {
        let el = start;
        let depth = 0;
        while (el && el !== document.body && depth < 12) {
            const rect = el.getBoundingClientRect();
            if (rectLooksLikeSidebar(rect)) return el;
            el = el.parentElement;
            depth += 1;
        }
        return null;
    }

    function findByTextContent(needles) {
        const lowered = needles.map(n => n.toLowerCase());
        const all = document.body ? document.body.querySelectorAll('a, button, span, div') : [];
        for (const el of all) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (!text || text.length > 64) continue;
            if (lowered.some(n => text === n || text.includes(n))) {
                return el;
            }
        }
        return null;
    }

    function findSidebar() {
        // 0. Reuse the user's previously-picked element, if it still exists.
        const pickedSelector = readPickedSelector();
        if (pickedSelector) {
            try {
                const found = document.querySelector(pickedSelector);
                if (found) return found;
            } catch (e) { /* invalid selector — ignore */ }
        }

        // 1. Stable TikTok nav hooks.
        const navHook = document.querySelector(
            '[data-e2e^="nav-"], [data-e2e="top-login-button"], ' +
            '[data-e2e="top-account-menu"], a[href="/foryou"], ' +
            'a[href="/following"], a[href="/explore"], a[href="/live"]'
        );
        if (navHook) {
            const found = walkUpForSidebarShape(navHook);
            if (found) return found;
        }

        // 2. Visible label text (matches the screenshot the user shared).
        const labelHook = findByTextContent([
            'Get Coins', 'Discover LIVE', 'Go LIVE',
            'Creator tools', 'For You',
        ]);
        if (labelHook) {
            const found = walkUpForSidebarShape(labelHook);
            if (found) return found;
        }

        // 3. Shape-based scan over likely structural elements.
        const candidates = document.querySelectorAll(
            'aside, nav, [role="navigation"], [class*="SideNav" i], ' +
            '[class*="Sidebar" i], [class*="LeftNav" i]'
        );
        for (const c of candidates) {
            if (rectLooksLikeSidebar(c.getBoundingClientRect())) return c;
        }

        return null;
    }

    function readPickedSelector() {
        try { return localStorage.getItem(PICKED_PATH_KEY) || ''; }
        catch (e) { return ''; }
    }

    function writePickedSelector(sel) {
        try {
            if (sel) localStorage.setItem(PICKED_PATH_KEY, sel);
            else localStorage.removeItem(PICKED_PATH_KEY);
        } catch (e) { /* ignore */ }
    }

    function readState() {
        try { return localStorage.getItem(STATE_KEY) === '1'; }
        catch (e) { return false; }
    }

    function writeState(collapsed) {
        try { localStorage.setItem(STATE_KEY, collapsed ? '1' : '0'); }
        catch (e) { /* ignore */ }
    }

    // Build a CSS-path selector unique enough to refind a chosen element
    // across reloads. We prefer id, then data-e2e, then a structural path
    // capped at five ancestors.
    function buildSelector(el) {
        if (!el || el === document.body) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        const e2e = el.getAttribute('data-e2e');
        if (e2e) return `[data-e2e="${e2e}"]`;
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur !== document.body && depth < 5) {
            let part = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                if (sameTag.length > 1) {
                    part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
                }
            }
            parts.unshift(part);
            cur = cur.parentElement;
            depth += 1;
        }
        return parts.join(' > ');
    }

    function applyState(collapsed, el) {
        if (!el) return;
        if (collapsed) {
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute(HIDDEN_ATTR, '1');
        } else {
            el.style.removeProperty('display');
            el.removeAttribute(HIDDEN_ATTR);
        }
    }

    function clearAllHidden() {
        document.querySelectorAll(`[${HIDDEN_ATTR}="1"]`).forEach(el => {
            el.style.removeProperty('display');
            el.removeAttribute(HIDDEN_ATTR);
        });
    }

    function injectStyles() {
        if (document.getElementById('ttlive-collapse-styles')) return;
        const style = document.createElement('style');
        style.id = 'ttlive-collapse-styles';
        style.textContent = `
            #ttlive-toggle-btn {
                position: fixed; top: 12px; left: 12px; z-index: 2147483647;
                width: 36px; height: 36px; border-radius: 18px; border: none;
                background: rgba(0,0,0,0.55); color: #fff; font-size: 18px;
                line-height: 36px; text-align: center; cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                box-shadow: 0 2px 8px rgba(0,0,0,0.35);
                transition: background 0.15s ease, transform 0.15s ease;
                user-select: none; padding: 0;
            }
            #ttlive-toggle-btn:hover { background: rgba(254,44,85,0.85); transform: scale(1.05); }
            #ttlive-toggle-btn:focus { outline: 2px solid #fe2c55; outline-offset: 2px; }
            #ttlive-toggle-btn[data-mode="picking"] { background: #fe2c55; }
            #ttlive-pick-overlay {
                position: fixed; pointer-events: none; z-index: 2147483646;
                background: rgba(254,44,85,0.18); border: 2px solid #fe2c55;
                box-sizing: border-box; transition: all 0.05s linear;
            }
            #ttlive-toast {
                position: fixed; top: 56px; left: 12px; z-index: 2147483647;
                background: rgba(0,0,0,0.78); color: #fff; padding: 8px 12px;
                border-radius: 6px; font: 13px/1.3 -apple-system, "Segoe UI", sans-serif;
                max-width: 320px; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    function showToast(msg, ttl = 3000) {
        const old = document.getElementById('ttlive-toast');
        if (old) old.remove();
        const t = document.createElement('div');
        t.id = 'ttlive-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => { if (t.parentNode) t.remove(); }, ttl);
    }

    function setBtnLabel(btn, collapsed) {
        btn.textContent = collapsed ? '»' : '«';
        btn.title = collapsed
            ? 'Show TikTok left sidebar (shift-click to re-pick)'
            : 'Hide TikTok left sidebar (shift-click to re-pick)';
        btn.setAttribute('aria-pressed', String(collapsed));
        btn.setAttribute('data-mode', 'normal');
    }

    /* ---------- pick-mode (manual fallback) ---------- */

    let pickActive = false;
    let pickHoverEl = null;
    let pickOverlay = null;

    function enterPickMode(btn) {
        pickActive = true;
        btn.setAttribute('data-mode', 'picking');
        btn.textContent = '◎';
        btn.title = 'Pick mode: click the sidebar to hide. Esc to cancel.';
        showToast('Pick mode: click the element you want to hide. Esc to cancel.', 5000);
        pickOverlay = document.createElement('div');
        pickOverlay.id = 'ttlive-pick-overlay';
        document.body.appendChild(pickOverlay);
        document.addEventListener('mousemove', onPickMove, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
    }

    function exitPickMode(btn) {
        pickActive = false;
        document.removeEventListener('mousemove', onPickMove, true);
        document.removeEventListener('click', onPickClick, true);
        document.removeEventListener('keydown', onPickKey, true);
        if (pickOverlay && pickOverlay.parentNode) pickOverlay.remove();
        pickOverlay = null;
        pickHoverEl = null;
        const collapsed = readState();
        setBtnLabel(btn, collapsed);
    }

    function onPickMove(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el.id === 'ttlive-toggle-btn' || el.id === 'ttlive-pick-overlay') return;
        pickHoverEl = el;
        const r = el.getBoundingClientRect();
        if (pickOverlay) {
            pickOverlay.style.left = r.left + 'px';
            pickOverlay.style.top = r.top + 'px';
            pickOverlay.style.width = r.width + 'px';
            pickOverlay.style.height = r.height + 'px';
        }
    }

    function onPickClick(e) {
        if (!pickActive) return;
        e.preventDefault();
        e.stopPropagation();
        const target = pickHoverEl;
        const btn = document.getElementById('ttlive-toggle-btn');
        if (!target) { exitPickMode(btn); return; }
        const sel = buildSelector(target);
        if (!sel) {
            showToast('Could not build a selector for that element.', 3500);
            exitPickMode(btn);
            return;
        }
        writePickedSelector(sel);
        writeState(true);
        exitPickMode(btn);
        applyToggle();
        showToast('Saved. Shift-click the button to re-pick.', 3500);
    }

    function onPickKey(e) {
        if (e.key === 'Escape') {
            const btn = document.getElementById('ttlive-toggle-btn');
            exitPickMode(btn);
            showToast('Pick cancelled.', 1800);
        }
    }

    /* ---------- main toggle ---------- */

    function applyToggle() {
        const collapsed = readState();
        clearAllHidden();
        if (!collapsed) {
            const btn = document.getElementById('ttlive-toggle-btn');
            if (btn) setBtnLabel(btn, false);
            return;
        }
        const target = findSidebar();
        if (!target) {
            console.warn(LOG_PREFIX, 'sidebar not found — try shift-click on the toggle to pick manually');
            showToast('Sidebar not found. Shift-click the button to pick it manually.', 4500);
            writeState(false);
            const btn = document.getElementById('ttlive-toggle-btn');
            if (btn) setBtnLabel(btn, false);
            return;
        }
        applyState(true, target);
        const btn = document.getElementById('ttlive-toggle-btn');
        if (btn) setBtnLabel(btn, true);
    }

    function ensureToggleButton() {
        if (document.getElementById('ttlive-toggle-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'ttlive-toggle-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Toggle TikTok left sidebar');
        btn.addEventListener('click', (e) => {
            if (e.shiftKey) {
                if (pickActive) exitPickMode(btn);
                else enterPickMode(btn);
                return;
            }
            if (pickActive) return;
            writeState(!readState());
            applyToggle();
        });
        document.body.appendChild(btn);
        applyToggle();
    }

    function removeToggleButton() {
        const btn = document.getElementById('ttlive-toggle-btn');
        if (btn) btn.remove();
        clearAllHidden();
    }

    function refresh() {
        if (isLivePage()) {
            injectStyles();
            if (document.body) ensureToggleButton();
            else window.addEventListener('DOMContentLoaded', ensureToggleButton, { once: true });
        } else {
            removeToggleButton();
        }
    }

    /* ---------- SPA route handling ---------- */

    let lastPath = location.pathname + location.search;
    new MutationObserver(() => {
        const cur = location.pathname + location.search;
        if (cur !== lastPath) {
            lastPath = cur;
            refresh();
        } else if (isLivePage() && readState()) {
            // Re-apply hidden state if TikTok re-renders the sidebar.
            const target = findSidebar();
            if (target && !target.hasAttribute(HIDDEN_ATTR)) {
                applyState(true, target);
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
        const r = origPush.apply(this, arguments);
        setTimeout(refresh, 0);
        return r;
    };
    history.replaceState = function () {
        const r = origReplace.apply(this, arguments);
        setTimeout(refresh, 0);
        return r;
    };
    window.addEventListener('popstate', refresh);

    refresh();
    // TikTok's live layout often hydrates after document-end; re-try a few times.
    setTimeout(refresh, 500);
    setTimeout(refresh, 1500);
    setTimeout(refresh, 3500);
})();
