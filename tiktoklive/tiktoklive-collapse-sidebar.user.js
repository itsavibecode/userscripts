// ==UserScript==
// @name         TikTok LIVE — Collapse Left Sidebar
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.1.0
// @description  Adds a toggle button on TikTok LIVE pages that collapses the left navigation sidebar (TikTok logo, Discover LIVE, Go LIVE, Creator tools, Get Coins, Following list) to give the live video and chat more breathing room. Preference persists across sessions.
// @author       itsavibecode
// @match        https://www.tiktok.com/*
// @match        https://www.tiktok.com/*/live*
// @run-at       document-end
// @grant        none
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/tiktoklive
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/tiktoklive/tiktoklive-collapse-sidebar.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/tiktoklive/tiktoklive-collapse-sidebar.user.js
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'ttlive_sidebar_collapsed';
    const HIDDEN_CLASS = 'ttlive-sidebar-hidden';

    // CSS selectors that target TikTok's left navigation sidebar on LIVE pages.
    // TikTok uses styled-components with hashed suffixes, so we match by prefix.
    // Multiple candidates are listed because TikTok ships A/B variants.
    const SIDEBAR_SELECTORS = [
        '[class*="DivSideNavContainer"]',
        '[class*="DivSidebarContainer"]',
        '[class*="DivSideNavWrapper"]',
        '[class*="StyledSideNavWrapper"]',
        '[data-e2e="nav-sidebar"]',
        '[data-e2e="live-side-nav-container"]',
    ];

    function isLivePage() {
        return /\/live(\b|\/|\?|$)/.test(location.pathname + location.search);
    }

    function injectStyles() {
        if (document.getElementById('ttlive-collapse-styles')) return;
        const style = document.createElement('style');
        style.id = 'ttlive-collapse-styles';
        style.textContent = `
            html.${HIDDEN_CLASS} ${SIDEBAR_SELECTORS.join(', html.' + HIDDEN_CLASS + ' ')} {
                display: none !important;
            }
            /* When collapsed, let the live layout reclaim the freed horizontal space */
            html.${HIDDEN_CLASS} [class*="DivBodyContainer"],
            html.${HIDDEN_CLASS} [class*="DivLiveContainer"],
            html.${HIDDEN_CLASS} [class*="DivContentContainer"] {
                margin-left: 0 !important;
                padding-left: 0 !important;
            }
            #ttlive-toggle-btn {
                position: fixed;
                top: 12px;
                left: 12px;
                z-index: 2147483647;
                width: 36px;
                height: 36px;
                border-radius: 18px;
                border: none;
                background: rgba(0, 0, 0, 0.55);
                color: #fff;
                font-size: 18px;
                line-height: 36px;
                text-align: center;
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
                transition: background 0.15s ease, transform 0.15s ease;
                user-select: none;
                padding: 0;
            }
            #ttlive-toggle-btn:hover {
                background: rgba(254, 44, 85, 0.85);
                transform: scale(1.05);
            }
            #ttlive-toggle-btn:focus {
                outline: 2px solid #fe2c55;
                outline-offset: 2px;
            }
        `;
        document.head.appendChild(style);
    }

    function setCollapsed(collapsed) {
        const html = document.documentElement;
        if (collapsed) {
            html.classList.add(HIDDEN_CLASS);
        } else {
            html.classList.remove(HIDDEN_CLASS);
        }
        try {
            localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
        } catch (e) { /* localStorage unavailable */ }
        const btn = document.getElementById('ttlive-toggle-btn');
        if (btn) {
            btn.textContent = collapsed ? '»' : '«';
            btn.title = collapsed
                ? 'Show TikTok left sidebar'
                : 'Hide TikTok left sidebar';
            btn.setAttribute('aria-pressed', String(collapsed));
        }
    }

    function readSavedState() {
        try {
            return localStorage.getItem(STORAGE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function ensureToggleButton() {
        if (document.getElementById('ttlive-toggle-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'ttlive-toggle-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Toggle TikTok left sidebar');
        btn.addEventListener('click', () => {
            const isCollapsed = document.documentElement.classList.contains(HIDDEN_CLASS);
            setCollapsed(!isCollapsed);
        });
        document.body.appendChild(btn);
        setCollapsed(readSavedState());
    }

    function removeToggleButton() {
        const btn = document.getElementById('ttlive-toggle-btn');
        if (btn) btn.remove();
        document.documentElement.classList.remove(HIDDEN_CLASS);
    }

    function refresh() {
        if (isLivePage()) {
            injectStyles();
            // document.body may not exist at @run-at document-end on slow pages
            if (document.body) {
                ensureToggleButton();
            } else {
                window.addEventListener('DOMContentLoaded', ensureToggleButton, { once: true });
            }
        } else {
            removeToggleButton();
        }
    }

    // Watch for SPA navigation — TikTok swaps routes without a full reload.
    let lastPath = location.pathname + location.search;
    const navObserver = new MutationObserver(() => {
        const current = location.pathname + location.search;
        if (current !== lastPath) {
            lastPath = current;
            refresh();
        }
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Also hook history methods for faster SPA detection
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
})();
