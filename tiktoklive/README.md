# TikTok LIVE — Collapse Left Sidebar

A Tampermonkey userscript that hides TikTok's left navigation sidebar on LIVE
stream pages, freeing horizontal space for the video and chat.

The hidden sidebar is the column that contains the TikTok logo, **Back**,
**Discover LIVE**, **Go LIVE**, **Creator tools**, **More**, **Get Coins**, and
the **Following** list.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open
   [tiktoklive-collapse-sidebar.user.js](./tiktoklive-collapse-sidebar.user.js)
   on GitHub and click the **Raw** button. Tampermonkey will pick it up and
   show an install prompt.
3. Confirm the install.

## Use

1. Open any TikTok LIVE page, for example
   `https://www.tiktok.com/@<creator>/live`.
2. A small round toggle button appears at the top-left corner of the page.
   - Click it once to collapse the left sidebar (button shows `»`).
   - Click again to bring the sidebar back (button shows `«`).
3. Your preference is remembered across page loads via `localStorage`, so
   you only have to set it once.

## How it works

TikTok renders its web UI with styled-components, so class names have a stable
prefix and a hashed suffix. The script targets the sidebar via prefix
selectors like `[class*="DivSideNavContainer"]` and several A/B variants, then
applies `display: none` while the toggle is on. A `MutationObserver` plus
`history.pushState`/`replaceState` hooks re-apply the toggle when TikTok
swaps routes without a full reload.

## Compatibility

Tested in Chrome with Tampermonkey on the desktop TikTok web UI as of
2026-04-28. If TikTok ships a layout change that makes the sidebar reappear,
open an issue and the selector list in the script can be extended.

## Changelog

### v0.1.0 — 2026-04-28
- Initial release. Floating toggle button at top-left, persisted preference,
  SPA-aware refresh, prefix-based selectors with several A/B fallbacks.
