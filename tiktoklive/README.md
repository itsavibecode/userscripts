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

## If automatic detection misses

TikTok ships several A/B variants of its web UI, so automatic detection
isn't perfect. If you click the toggle and nothing happens:

1. **Shift-click** the round toggle button. The button turns pink and a
   tooltip says *Pick mode*.
2. Hover the page — a pink outline follows your cursor.
3. Click the sidebar (any part of it works — the script walks up to the
   container shape).
4. The script saves a CSS selector for that element in `localStorage` and
   collapses it. Next time the page loads, the same element is hidden
   automatically.

Press **Esc** during pick mode to cancel. Shift-click the toggle again any
time to re-pick a different element.

## How it works

TikTok styles its UI with hashed class names, so matching by class is
brittle. The script finds the sidebar by structure instead:

1. Look for stable nav signals — `data-e2e^="nav-"` attributes, links to
   `/foryou` or `/following`, or visible labels like *Get Coins* and
   *Discover LIVE*.
2. Walk up from that hook until an ancestor's bounding rect matches the
   sidebar shape (pinned to `left: 0`, 60–400px wide, at least half the
   viewport tall).
3. Fall back to scanning every `<aside>`, `<nav>`, and sidebar-ish wrapper
   for that same shape.
4. If all of that fails, the manual pick-mode above takes over and stores
   the selector for next time.

A `MutationObserver` plus `history.pushState` / `replaceState` hooks
re-apply the hide when TikTok swaps routes without a full reload, so
navigating between live streams keeps the sidebar collapsed.

## Compatibility

Tested in Chrome with Tampermonkey on the desktop TikTok web UI as of
2026-04-28. If TikTok ships a layout change that makes auto-detection miss,
shift-click the toggle and pick the sidebar manually — the saved selector
will keep working until the layout changes again.

## Changelog

### v0.1.1 — 2026-04-28
- Replace fragile class-prefix selectors with structural detection
  (data-e2e nav hooks, visible labels, then shape-based fallback).
- Add shift-click *pick mode* with a hover outline and a saved CSS path,
  so any layout the auto-detector misses can be fixed in one click.
- Toast messages explain when detection fails or pick mode is active.
- Re-apply the hide on TikTok's late hydration (retries at 0.5s / 1.5s /
  3.5s after page load).

### v0.1.0 — 2026-04-28
- Initial release. Floating toggle button at top-left, persisted preference,
  SPA-aware refresh, prefix-based selectors with several A/B fallbacks.
