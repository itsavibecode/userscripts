# HDToday Date Filter

Adds what the hdtoday streaming front-end is missing: filtering and sorting by
**full release date** ("released on or before X", "between X and Y") and a
**Hide unreleased** toggle so "Newest First" stops being a wall of films that
are not out yet.

- **Listing pages** (`/movies`, `/tv`, `/genre/{slug}`, `/year/{yyyy}`): a
  **Released from / to** date range plus **Hide unreleased** sit next to the
  site's own filter selects. With a range set, results come straight from TMDB
  (The Movie Database) using the page's genre and sort, drawn in the site's own
  card style with the **full release date** on every card, and prev/next paging.
  Needs your own free TMDB key (see below).
- **Search box**: the same date range is applied to search results, each row
  shows the full release date instead of just the year, and a **Show all N
  results** button lifts the site's cap of 8. No key needed.
- **Settings panel**: draggable, resizable (bottom-right corner), collapsible
  (the – / + in its header); position, size and state persist. Open it from the
  gear button in the filter bar or the Tampermonkey menu.
- **Copy m3u8**: on a watch page a **Stream link** row sits above the server
  buttons. Once the player starts, it shows the host of the `.m3u8` the player
  is using, with **Copy m3u8** and **Open** buttons. The link is remembered,
  and the title's detail page shows the same Copy button next to the poster
  until the link's token runs out (the hosts hand out tokens that last a few
  hours and only work from your own network).

## How the stream link is found

The player is a chain of cross-origin iframes (site, then an embed host, then
the stream host), so the page itself never sees the `.m3u8`. The script runs at
document-start in every frame whose ancestor is the site, hooks `fetch`,
`XMLHttpRequest` and media `src` there, and posts any `.m3u8` URL to the top
page. The first one seen for a server is treated as the master playlist; a
server switch clears it. If a player loads its stream some other way (service
worker, blob), the row keeps saying "Waiting for the player", which is honest:
the script did not see a playlist.

## Why TMDB, and the key

The site is a thin front-end over TMDB: `/movie/{id}` and `/tv/{id}` use TMDB
ids, and the genre ids and `sort_by` values in its listing URLs are TMDB
discover parameters passed through verbatim. What the site does *not* pass
through is any date bound, and it ignores extra parameters, so a date filter
cannot be done through its own URLs. The script therefore asks TMDB's discover
endpoint directly, with `primary_release_date.gte/lte` (movies) or
`first_air_date.gte/lte` (TV), and links each result back to the site.

That call needs a TMDB key. It is free:

1. Create an account at [themoviedb.org](https://www.themoviedb.org/).
2. Go to **Settings > API** (<https://www.themoviedb.org/settings/api>) and
   request a key. Either the **API Key (v3 auth)** or the longer **API Read
   Access Token (v4 auth)** works; paste either one.
3. On any listing page click the **gear** in the filter bar, paste the key,
   **Test**, then **Save**.

The key is stored only in Tampermonkey's storage in your browser and is sent
only to `api.themoviedb.org`. It is never written into the script. Until a key
is saved, the date controls are greyed out with a hint pointing at the settings
panel; the search-box filtering works regardless.

## Using it

| Control | Effect |
| --- | --- |
| Released from / to | Inclusive bounds. Leave either empty for open-ended ("on or before X" = only *to*). |
| Hide unreleased | Caps *to* at today, so nothing with a future date shows. Also works alone with no range. |
| Apply | Fetch from TMDB. The range is **remembered across pages** until you Clear it, so changing genre, sort or year on the site keeps it. |
| Clear | Forget the range and put the site's own listing back. |
| Gear | Opens the settings panel. |

On `/movies` the site's own Genre / Year / Sort selects are used. On `/tv`,
`/genre/...` and `/year/...` the site has no selects, so the bar adds its own
Genre and Sort (TMDB values; remembered). A year picked on the site, or a
`/year/2024` page, narrows the date range to that year.

Full dates on cards are shown as `YYYY-MM-DD`; a future date is highlighted and
its badge reads **Soon** instead of **HD**. Prev / Next use the browser history
(`#dfpage=N`), so Back works.

Notes:

- TMDB's "Newest First" (`primary_release_date.desc`) is dominated by obscure
  entries with no ratings; when sorting by date the script asks TMDB for titles
  with at least one vote. Other sorts are untouched.
- A title TMDB lists is not guaranteed to be playable on the site; cards link to
  `/movie/{id}` or `/tv/{id}` exactly as the site's own cards do.

## The domain changes

The site moves domains. The only thing tied to the domain is the `SITE_HOSTS`
list just below the header of the `.user.js`:

```
const SITE_HOSTS = ['hdtodayz.gd'];
```

When it moves, add the new domain to that list. Everything else is path-based
and keeps working.

Why the `@match` is `*://*/*` rather than the site: the Copy-m3u8 feature has to
run inside the player iframes, which live on other domains that change all the
time. On any page that is neither the site nor one of its player frames the
script exits in its first few lines, before touching the page. If you would
rather not have it match everything, change `@match` back to the site's URL
plus the embed hosts you use; the date filter and search features only need
the site itself.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`hdtoday-date-filter.user.js`](./hdtoday-date-filter.user.js) on GitHub
   and click **Raw**. Tampermonkey shows an install prompt.
3. Open a listing page on the site. The console logs
   `[HDToday Date Filter] v0.1.0 active` and the date controls appear in the
   filter bar.

## If it stops working

The site's markup the script relies on: filter selects `#filterGenre`,
`#filterYear`, `#filterSortBy` (movies page), the card grid `main .grid` holding
`a.card`, the "Page x of y" pager right after it, the search modal's
`#searchResults` and global `doSearch()` which fetches `/api/search?q=`. All
selectors live near the top of the `.user.js` (`pageContext`, `findGrid`,
`findPager`, `installSearch`).

## Changelog

### 0.2.0
- **Copy m3u8.** Watch pages get a **Stream link** row above the server
  buttons: once the player starts, it names the stream host and playlist, says
  when the link's token expires, and offers **Copy m3u8** and **Open**. The
  link is remembered so the title's detail page shows the same button next to
  the poster while it is still valid. Found by a document-start sniffer that
  runs inside the player iframes (they are cross-origin, so the page itself
  never sees the playlist), which is why `@match` is now `*://*/*` with an
  early exit everywhere else; the site's domains live in `SITE_HOSTS`.
- The date fields are no longer greyed out without a TMDB key. The range can
  always be set (the search box uses it with no key); Apply on a listing page
  without a key opens the settings panel instead of fetching.

### 0.1.0
- Initial release. Date range (from / to) and Hide-unreleased on listing pages,
  backed by TMDB discover with the site's genre / sort and prev / next paging;
  full release date on every card. Search modal filtered by the same range with
  full dates and a Show-all button. Draggable / resizable / collapsible settings
  panel holding the TMDB key (GM storage only) and options.
