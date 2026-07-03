# Kick Chat Cleaner

Quiets down [kick.com](https://kick.com) chat by hiding two kinds of noise as
messages arrive:

- **Emote-only messages** — anything whose whole body is just emotes with no
  actual text.
- **Duplicate messages** — repeated/copypasta lines, keeping the **first**
  (original) occurrence and hiding the rest.

Everything runs live on the chat feed and also re-sweeps when you switch
channels (Kick is a single-page app).

## How it works

- A `MutationObserver` watches the chat container for new message entries.
- For each entry the script clones the content, strips the username, badges and
  timestamp, then removes emote images. If at least one emote was present and
  **nothing else is left**, it's an emote-only message.
- For duplicate detection it builds a signature from the normalized text plus
  the emote sequence and keeps a rolling window of recent signatures. The first
  time a signature is seen the message is kept; any later match is hidden.
- Messages are hidden with `display:none` by default (safe against the
  framework re-rendering); you can switch to hard-removing the nodes.

## Settings

Toggle these from the **Tampermonkey menu** while on a kick.com tab (each change
reloads the page):

| Toggle | Default | Effect |
| --- | --- | --- |
| Hide emote-only messages | on | Hide messages that are only emotes. |
| Hide duplicate messages | on | Collapse repeats, keeping the original. |
| Duplicates: per-user only | **off** | Off = copypasta from *different* users also collapses (classic spam dedupe). On = only a single user repeating themselves is collapsed. |
| Remove (instead of hide) nodes | off | Hard-remove matched nodes from the DOM instead of hiding them. |

The `duplicateWindow` (how many recent kept messages to remember, default 300)
lives in the `cfg` block at the top of the `.user.js`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open
   [`kick-chat-cleaner.user.js`](./kick-chat-cleaner.user.js) on GitHub and
   click **Raw** — Tampermonkey shows an install prompt.
3. Reload a kick.com channel. The console logs `[Kick Chat Cleaner] active` to
   confirm it loaded.

## If it stops catching messages

Kick ships DOM changes fairly often. The script matches message entries and
emotes through several fallback selectors (`ENTRY_SELECTORS` and the emote
selector list near the top of the `.user.js`). If a Kick update breaks
detection, those lists are the place to update.

## Changelog

### 0.1.0
- Initial release: emote-only message hiding and duplicate collapsing (keeping
  the original), live via a `MutationObserver`, with channel-switch re-sweeps
  and Tampermonkey-menu toggles for each behaviour.
