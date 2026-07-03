# Kick Chat Cleaner

Quiets down [kick.com](https://kick.com) chat by removing noise:

- **Emote-only messages** — anything whose whole body is just emotes with no
  actual text.
- **Duplicate messages** — repeated/copypasta lines, keeping the **first**
  (original) occurrence and dropping the rest.
- **Custom phrases** — messages containing any word or phrase on your blocklist.

A small GUI shows live counts of what's been removed and lets you toggle each
behaviour. The panel is **draggable, resizable** (drag the bottom-right corner),
and **collapsible** (the – / + in its header); its position and size persist. A
**slide-out log** (the ▤ button, or click any counter) lists exactly which
messages were removed, tabbed by **Emote / Dupes / Phrase**.

## How it works (and why it's not a `display:none` script)

Kick renders chat with a **virtualized list**: each message row is absolutely
positioned, and the list measures a row's height once when it mounts and then
**never reflows**. Hiding or shrinking a row's DOM node therefore leaves a
permanent blank gap where the message used to be — which is why the obvious
"`querySelector` + `display:none`" approach looks broken on Kick.

So this script filters one level up, **before** anything renders. Kick receives
chat over a Pusher-style WebSocket, one frame per message:

```
{ event: "App\\Events\\ChatMessageEvent", data: "<json>", channel: "chatrooms.<id>.v2" }
```

where `JSON.parse(data)` is `{ id, content, sender: { username, … }, … }` and
emotes are encoded inside `content` as literal `[emote:<id>:<name>]` tokens
(e.g. `[emote:37226:KEKW]`).

At `document-start` (before Kick's client grabs `WebSocket`) the script wraps
the socket's message handler — both the `onmessage` setter and
`addEventListener('message')`, since Kick uses both — and simply **doesn't
forward** the chat frames it wants to remove. Kick never sees them, never
renders them, and there's **no gap**.

- **Emote-only** — strip every `[emote:…]` token from `content`; if nothing but
  whitespace is left, drop it.
- **Duplicate** — build a signature from the normalized `content` and keep a
  rolling window of recent signatures. First occurrence is kept; later matches
  are dropped.
- **Custom phrase** — build a searchable form of `content` (emote tokens reduced
  to their name, lowercased) and drop the message if it contains any phrase on
  your list. Matching is a case-insensitive substring, so `gamble` also catches
  `gambling` and `kekw` catches the KEKW emote.

Any frame that can't be parsed is always passed through untouched, so chat can
never break — the worst case is that filtering silently stops.

## Settings

Use the on-screen panel, or the **Tampermonkey menu** (menu changes reload the
page):

| Setting | Default | Effect |
| --- | --- | --- |
| Enabled | on | Master switch for all filtering. |
| Remove emote-only | on | Drop messages that are only emotes. |
| Remove duplicates | on | Drop repeats, keeping the original. |
| Per-user only | **on** | On = only a single user repeating *themselves* collapses (the intuitive default). Off = copypasta from *different* users also collapses (aggressive spam dedupe). |
| Duplicate memory | 200 | How many recent kept messages to remember when checking for duplicates. |
| Remove custom phrases | off | Drop messages containing any phrase from the box below (one per line). |

**A note on the duplicate default.** *Per-user only* is **on** by default, so the
cleaner only collapses a single user repeating *themselves* — it won't touch
short reactions like `no`, `yes`, or `W` that different people happen to type. If
you'd rather aggressively squash copypasta trains across *all* users (at the cost
of also removing those incidental repeats), turn **Per-user only** off.

Emoji typed as normal Unicode (😂) count as text and are **not** removed — only
Kick's `[emote:…]` emotes do.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open
   [`kick-chat-cleaner.user.js`](./kick-chat-cleaner.user.js) on GitHub and
   click **Raw** — Tampermonkey shows an install prompt.
3. Reload a kick.com channel. The console logs `[Kick Chat Cleaner] v0.4.1
   active` and the panel appears (top-right by default; drag it anywhere). The
   **Scanned** counter should start climbing as chat comes in — that confirms
   the filter is live.

**Updating from an older version:** Tampermonkey → installed scripts → Kick
Chat Cleaner → **Settings** → *Check for userscript updates*, or just reinstall
from the Raw link above. (v0.1.0 had no GUI and used a DOM-hiding approach that
didn't work on Kick's virtualized chat — if you don't see the panel, you're
still on it.)

Note: messages already in chat when the page loads (the initial backlog) are
loaded over HTTP, not the live socket, so they aren't filtered — only messages
that arrive live are. The backlog scrolls away on its own.

## If it stops working

Kick can change its realtime format. The parsing lives in `shouldDropFrame` and
the `[emote:…]` matching in `EMOTE_TOKEN`, both near the top of the `.user.js`.
Open DevTools (F12) → Console to confirm the `v0.2.0 active` line, and watch the
panel's counters to see whether frames are being matched.

## Changelog

### 0.4.1
- **Per-user only** now defaults to **on**. Cross-user dedup was too aggressive as
  a default — it collapsed common short reactions (`no`, `yes`, `W`) typed by
  different people. The default now only collapses a user repeating themselves;
  flip it off for the aggressive cross-user copypasta dedupe.

### 0.4.0
- Added a **slide-out log of removed messages.** Click the ▤ button in the
  header (or any of the counters) to slide out a drawer showing exactly what was
  removed, tabbed by **Emote / Dupes / Phrase**, newest first, each with the
  sender, the message (emotes shown as `:name:`), and a timestamp. **Clear**
  empties the current tab. Open/closed state and the active tab persist.
- The panel is now a container holding the settings column plus the drawer, so
  the log slides out to the side without covering chat.

### 0.3.2
- **Fixed the toggles not being clickable and the panel sometimes hiding behind
  Kick's UI** — the two were the same problem: the panel could render under one
  of Kick's high-`z-index` overlays, so clicks landed on Kick's element instead
  of the switches. The panel now renders in the browser **top layer** (via the
  popover API, with a max-`z-index` fallback) so it sits above everything and
  stays clickable, and it re-asserts itself when the player goes
  fullscreen/theater. Each toggle's whole row is now a `<label>`, so clicking
  the switch itself works, not just the text.
- Added a live **Scanned** counter so you can see the filter working as soon as
  chat arrives, even before anything is removed.
- Fixed the default panel position (an `inset` ordering bug had let it drift to
  the top-left); it anchors top-right again.

### 0.3.1
- Panel is now **resizable** (drag the bottom-right corner) with the size saved
  and restored, in addition to being draggable and collapsible. Collapsing
  shrinks it to just the header (no empty space), and the body scrolls when the
  panel is made shorter than its contents.

### 0.3.0
- Added a **custom phrase blocklist** — a box in the panel (one phrase per
  line); any message containing a listed phrase is dropped. Case-insensitive
  substring match, and emotes are matched by name.
- Renamed the toggles to "Remove …" and rebuilt the panel with a phrase box and
  a third live counter. GUI now builds through a small `el()` helper (no
  `innerHTML`), verified rendering on a live channel.

### 0.2.0
- **Rewritten to filter at the WebSocket layer instead of hiding DOM nodes.**
  Kick's chat is a virtualized list that never reflows after a row mounts, so
  hiding messages left blank gaps. The cleaner now intercepts the chat socket at
  `document-start` and drops emote-only / duplicate frames before Kick renders
  them — gap-free, and it can't break chat (unparseable frames pass through).
  Verified live: emote-only and duplicate messages stop appearing with no gaps
  while normal chat flows.
- Added a **draggable on-screen panel** with an Enabled switch, per-behaviour
  toggles, an adjustable duplicate-memory size, and live counters for how many
  emote-only and duplicate messages have been removed. Position and settings
  persist.

### 0.1.0
- Initial release: emote-only message hiding and duplicate collapsing (keeping
  the original), live via a `MutationObserver`, with channel-switch re-sweeps
  and Tampermonkey-menu toggles for each behaviour. (Superseded by 0.2.0 — the
  DOM-hiding approach left gaps in Kick's virtualized chat.)
