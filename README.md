# userscripts

A small collection of Tampermonkey userscripts that polish web apps I use
every day.

| Script | What it does |
| --- | --- |
| [tiktoklive](./tiktoklive) | Toggle the left navigation sidebar on TikTok LIVE pages so the video and chat get more room. |
| [gemini-activity](./gemini-activity) | Manager panel for Gemini My Activity: load everything, then bulk-delete by date or by post with checkboxes and image/text previews. |
| [kick-autochat](./kick-autochat) | Auto-send a message to a Kick.com chat on a timer without needing window focus, with a draggable GUI, scheduled messages, and a mention watcher. |
| [kick-chat-cleaner](./kick-chat-cleaner) | Hide emote-only chat messages and collapse duplicate messages (keeping the original) on kick.com. |

## Installing any script in this repo

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Click into a script's folder above and open its `.user.js` file on GitHub.
3. Click the **Raw** button. Tampermonkey detects userscripts by URL and
   shows an install prompt.
4. Confirm.

Each subfolder has its own README with usage notes and a changelog.
