# Gemini My Activity — Bulk Manager

The Gemini activity feed at
[myactivity.google.com/product/gemini](https://myactivity.google.com/product/gemini)
is an endless scroll with no multi-select. This userscript overlays a manager
panel so you can load everything, see image + text previews, and **delete by
date or by individual post with checkboxes — all at once.**

It also works on other product feeds under `myactivity.google.com` (Search,
Maps, etc.), since they share the same layout.

## What it does

- **Load all** — auto-scrolls (and clicks any "Show more" button) until the
  feed stops growing, so every item is loaded into the page.
- **Scan** — reads the loaded feed into a list, each item tagged with its date,
  time, description, and thumbnail, grouped under its date header.
- **The panel** — every date is a collapsible group with a group checkbox
  (delete a whole day) and per-item checkboxes (delete single posts). Each row
  shows the image + a 3-line description preview and the time.
- **Select feedback** — one click selects every "Gave feedback:" item across
  the whole loaded feed (the thumbs up/down entries Gemini logs), so you can
  clear them all in a single delete pass.
- **Filter / Select all / Clear / Expand / Collapse** for working through a
  large feed quickly.
- **Delete selected** — performs Google's own delete action for each checked
  item (open the item's menu, click Delete, confirm), one at a time, with a
  progress bar and a **Stop** button. Failed items stay checked so you can
  retry; deleted rows are struck through and removed.

## How deletion works (and why)

Google offers no clean bulk-delete API for arbitrary multi-selections, so the
script drives the **same clicks you'd do by hand** — just automated and
sequential. That's the most reliable approach and it survives Google's frequent
markup changes better than reverse-engineering their internal endpoints.

Deletes are **permanent** and hit your real Google account. Nothing is deleted
until you (1) check items and (2) tick the "I understand…" confirmation in the
panel footer. **Stop** halts the queue between items at any time.

## If auto-detection misses

Google ships hashed, frequently-changing class names, so the script matches by
behaviour (date-shaped headers, clock times, menu/delete controls) rather than
classes. If a Google update breaks detection and **Scan** finds nothing:

1. Click **Teach a sample** and click one activity card. The script learns its
   shape and finds the sibling rows.
2. Open DevTools (F12) → Console. Every scan logs how many items and date
   headers it matched and which detection path was used.

The selector knobs live in the `CFG` block at the top of the `.user.js` if they
ever need tuning.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open
   [`gemini-activity-manager.user.js`](./gemini-activity-manager.user.js) on
   GitHub and click **Raw** — Tampermonkey shows an install prompt.
3. Go to [your Gemini activity](https://myactivity.google.com/product/gemini)
   and click the **Activity Manager** button (bottom-right).

## Changelog

### 0.3.0
- **Load all** now reliably auto-scrolls the infinite feed: it drags the last
  loaded item into view each round and watches both the item count and page
  height, stopping only when nothing new loads. Progress shows the running item
  count, and **Stop** halts it.
- **Fixed empty descriptions.** Row text (title + prompt) often lives inside a
  clickable element, which the old extraction was deleting. Descriptions now
  come from the row's rendered text with just the time and control labels
  removed, and each detected card now expands to the full row.

### 0.2.1
- Fixed the panel not opening on `myactivity.google.com` (the page enforces
  Trusted Types CSP, which blocks `innerHTML`). All UI is now built with DOM
  methods instead of HTML strings. The launcher button also reports errors
  instead of failing silently.

### 0.2.0
- Added a **Select feedback** button that selects every "Gave feedback:" item
  across the entire loaded feed in one click, for bulk deletion.

### 0.1.0
- Initial release: floating launcher + side panel; auto-scroll "Load all";
  heuristic scan grouping items by date with image/text previews; group- and
  item-level checkboxes; filter/select-all/expand controls; sequential
  delete-by-driving-Google's-UI with progress, Stop, and a permanence
  confirmation; "Teach a sample" pick-mode fallback and console diagnostics.
