# Kick GIF Clipper

Turn a moment of a live [kick.com](https://kick.com) stream into a GIF without
leaving the tab. Press **Record** (or grab the **last 15 seconds** from an
optional rewind buffer), then trim, cut and crop in a small editor that pops up
over the player, and download the GIF.

Everything runs in your browser. Nothing is uploaded, there is no Kick API, no
login, and the script makes no network requests at all.

## What you get

- **Launcher pill** on the player (bottom-right, just above Kick's control bar).
  Drag it by the dotted grip; it remembers where it sits *relative to the
  player*, so theater mode, fullscreen and window resizes keep it on the video.
  Double-click the grip to put it back. The minus collapses it to a small round
  **GIF** button.
- **Record / Stop** captures frames from the video (default 15 fps, 640 px wide,
  stops by itself after 30 s). While recording, the pill shows the elapsed time,
  frame count and memory used.
- **Rewind buffer** (off until you click **Last 15 s** once): keeps the last
  10 / 15 / 30 seconds in memory so you can clip something *after* it happened.
  A green chip shows when it's full and how much memory it uses; its x turns it
  off.
- **Editor**: preview with play / step, a filmstrip timeline with in / out
  handles, **Keep selection** (trim) and **Remove selection** (cut a piece out
  of the middle), a crop box with 8 handles and aspect presets (Free, 16:9, 1:1,
  4:5, 9:16), and output settings (width, fps, speed, loop, palette, dither)
  with a live size estimate that turns amber over 10 MB.
- **Export** runs in a background worker, so the stream keeps playing. The
  finished GIF shows in the editor with its real size; **Download GIF** saves it
  as `kick_<channel>_<YYYYMMDD-HHMMSS>.gif`.

The editor never closes on an outside click, and it never throws a clip away
without asking.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open
   [`kick-gif-clipper.user.js`](https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-gif-clipper/kick-gif-clipper.user.js)
   (the raw link). Tampermonkey shows an install prompt.
3. Open a live channel. The console logs `[GIF Clipper] v0.1.0 active` and the
   pill appears on the player.

The raw link is cached by GitHub for about 5 minutes. To test a version you just
pushed, use the raw URL with the commit SHA instead of `main`.

## Using it

| Do this | How |
| --- | --- |
| Record | **Record**, then **Stop** (or `Alt+Shift+R` twice) |
| Clip what just happened | Arm the buffer once (click **Last 15 s**), then **Last 15 s** or `Alt+Shift+L` |
| Show / hide the pill | `Alt+Shift+G` (or the Tampermonkey menu) |
| Play / pause the preview | `Space`, or click the preview |
| Step one frame | `Left` / `Right` (`Shift` = one second) |
| Set in / out at the playhead | `I` / `O`, or drag the green handles |
| Crop | Drag on the preview, or **Edit crop** and move the handles |

Editor keys only work while focus is inside the editor, so they never fight
Kick's chat box. `Tab` stays inside the editor while it's open. `Esc` closes
dialogs and settings only.

Hotkeys can be changed in settings (click the hotkey, press the new combo; it
must include Ctrl or Alt so it never fires while you type in chat).

## Settings (gear)

| Setting | Default | Why |
| --- | --- | --- |
| Capture fps | 15 | Smoother needs more memory and CPU; the GIF can use fewer. |
| Capture width | 640 px | Plenty for GIFs. 854 costs about 1.8x. |
| Max length | 30 s | A forgotten recording can't eat all your memory. |
| Rewind buffer | 15 s, off on load | Uses memory and a little CPU the whole time it's on. |
| Output defaults | 480 px, 15 fps, ordered dither, global palette, loop forever | What each new clip starts with. |
| File name | `kick_{channel}_{date}.gif` | `{channel}` and `{date}` are filled in. |
| Frame counter on the pill | on | See how big a recording is getting. |

**Backup / Restore** save and load your settings as JSON. **Diagnostics** copies
a short report (version, whether a player was found, capture rate, last error)
to paste into a bug report.

## Good to know

- **GIFs are big.** On busy camera footage expect roughly 0.35-0.5 bytes per
  pixel per frame: 480x270 for 10 s at 15 fps is about 7-10 MB. Lower the width
  or fps, crop, or pick dither **none** to get under a chat app's upload limit.
- **Keep the tab visible while recording.** Browsers slow down hidden tabs; the
  pill says "paused - tab hidden" and you get a toast about the missing time.
- If the computer can't keep up, capture steps down to a lower fps and the pill
  says so, instead of stuttering the stream.
- **Clips live in memory only.** Reloading the page loses an unsaved clip.
  Closing the editor frees all of its memory.
- An ad break plays inside the same video, so a recording during an ad
  captures the ad.
- Mature channels show an "I am 18+" gate instead of the player; the pill says
  "no player on this page" until you pass it.
- Video pixels only: no audio (GIFs have none), no chat or overlays.

## How it works

Kick's live player is an ordinary `<video>` fed by Media Source Extensions, and
its pixels are readable (drawing it onto a canvas does not taint the canvas). A
timer samples it at the capture fps, scales each frame onto an `OffscreenCanvas`
and stores it as a small WebP blob, skipping ticks where the video did not
advance. That gives the editor random access to every frame.

Export decodes the kept frames, applies the crop and size, and streams them to a
Blob-URL Web Worker that builds a 256-colour palette (one global palette sampled
from 12 frames, or one per frame), dithers (ordered Bayer 4x4 or
Floyd-Steinberg) and LZW-encodes the GIF. If a Worker can't be created, the same
code runs on the main thread in small steps.

GIF encoding uses [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 by Matt
DesLauriers (MIT), vendored inside the script with its license header. The
dithering is our own.

## Development

The pure parts (timeline, crop, dithering, the GIF writer and gifenc) live in
one `makeCore()` function that the script uses, the Worker runs, and Node can
load. Unit tests:

```bash
node --test test/*.test.js
```

They cover the kept-segment timeline (trim / cut / resample), crop math (clamp,
aspect lock, handles, letterbox mapping), dithering on a gradient, and an
encoder round trip that parses the GIF back (header, loop block, frame count,
delays, LZW-decoded pixels), including the Worker message protocol.

## Changelog

### 0.1.0
- First release. Record or clip the last N seconds of a live Kick stream, trim /
  cut / crop it in a top-layer editor, and export a GIF in a background worker.
  Built to the Kick GIF Clipper plan (design direction B, "Graphite Calm"), and
  checked on two live channels: recording at a steady 15 fps, rewind buffer,
  trim and cut, crop with aspect lock, export, fullscreen, channel switch while
  recording, and the paused-stream case.
- The pill sits just above Kick's control bar by default (the plan had it at the
  very bottom, where it covered Kick's fullscreen and settings buttons).
- The size estimate uses measured numbers from live footage (about 4x higher
  than first assumed), so the 10 MB warning shows up when it should.
