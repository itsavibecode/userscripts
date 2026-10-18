// ==UserScript==
// @name         HDToday Date Filter
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.1.0
// @description  Filter and sort hdtoday listings by full release date ("released on or before X" / "between X and Y") with a Hide-unreleased toggle. Listing pages query TMDB discover directly with your own free TMDB key and render results in the site's own card style with full dates; the search modal is date-filtered client-side with no key needed. Draggable, resizable, collapsible settings panel.
// @author       itsavibecode
// @match        https://hdtodayz.gd/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @noframes
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/hdtoday-date-filter
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/hdtoday-date-filter/hdtoday-date-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/hdtoday-date-filter/hdtoday-date-filter.user.js
// ==/UserScript==

/*
 * The site's domain changes over time. To follow it, add another
 *     // @match        https://NEW-DOMAIN/*
 * line above (one per domain). Everything else is path-based and keeps working.
 *
 * HOW THIS WORKS
 * --------------
 * The site is a thin front-end over TMDB (The Movie Database): /movie/{id} and
 * /tv/{id} use TMDB ids, and its listing filters are TMDB discover values
 * passed through verbatim (genre ids, sort_by). What it does NOT pass through
 * is any date bound, so "Newest First" is full of unreleased future films.
 *
 *   Listing pages (/movies, /tv, /genre/{slug}, /year/{yyyy})
 *     When a date range (or Hide unreleased) is set, we skip the site's server
 *     and call TMDB discover ourselves with the page's genre / sort plus
 *     primary_release_date.gte/lte (first_air_date.* for TV). Results are
 *     drawn in the site's own card markup, linking back to /movie/{id} or
 *     /tv/{id}, with the FULL release date on each card and our own prev/next.
 *     This needs your own free TMDB key (settings panel, stored in GM storage).
 *
 *   Search modal
 *     The site's doSearch() calls /api/search?q= which already returns full
 *     release_date values. We replace doSearch with one that applies the same
 *     date range client-side and shows the full date. No key needed.
 */

(function () {
  'use strict';

  const VERSION = '0.1.0';
  const TAG = '[HDToday Date Filter]';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* ------------------------------------------------------------------ *
   * Storage                                                              *
   * ------------------------------------------------------------------ */
  const store = {
    get(k, d) { try { const v = GM_getValue(k, d); return v === undefined ? d : v; } catch (_) { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch (_) {} },
  };

  const cfg = {
    apiKey: store.get('apiKey', ''),
    // Default state of the Hide-unreleased toggle when no range has been saved yet.
    hideUnreleasedDefault: store.get('hideUnreleasedDefault', false),
    // Search modal: show every matching result instead of the site's cap of 8.
    searchShowAll: store.get('searchShowAll', false),
    // Date range, remembered across pages so paging / changing genre keeps it.
    range: store.get('range', null),
    // Our own genre / sort picks for pages where the site has no selects.
    tvGenre: store.get('tvGenre', ''),
    tvSort: store.get('tvSort', 'popularity.desc'),
    movieSort: store.get('movieSort', 'popularity.desc'),
    panel: store.get('panel', { x: null, y: null, w: 340, h: null, collapsed: false, open: false }),
  };
  if (!cfg.range) cfg.range = { from: '', to: '', hideUnreleased: cfg.hideUnreleasedDefault };

  const saveRange = () => store.set('range', cfg.range);
  const savePanel = () => store.set('panel', cfg.panel);

  /* ------------------------------------------------------------------ *
   * Site knowledge                                                       *
   * ------------------------------------------------------------------ */
  const SEARCH_CAP = 8;                 // the site's own result cap
  const IMG = 'https://image.tmdb.org/t/p/';
  const TMDB = 'https://api.themoviedb.org/3';
  const TMDB_MAX_PAGES = 500;           // TMDB refuses page > 500

  const MOVIE_GENRES = [
    [28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'],
    [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [14, 'Fantasy'], [36, 'History'],
    [27, 'Horror'], [10402, 'Music'], [9648, 'Mystery'], [10749, 'Romance'], [878, 'Sci-Fi'],
    [10770, 'TV Movie'], [53, 'Thriller'], [10752, 'War'], [37, 'Western'],
  ];
  const TV_GENRES = [
    [10759, 'Action & Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'],
    [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [10762, 'Kids'], [9648, 'Mystery'],
    [10763, 'News'], [10764, 'Reality'], [10765, 'Sci-Fi & Fantasy'], [10766, 'Soap'],
    [10767, 'Talk'], [10768, 'War & Politics'], [37, 'Western'],
  ];
  // /genre/{slug} pages: slug -> TMDB genre id, per media type.
  const SLUGS = {
    movie: {
      action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99,
      drama: 18, family: 10751, fantasy: 14, history: 36, horror: 27, music: 10402,
      mystery: 9648, romance: 10749, 'sci-fi': 878, 'science-fiction': 878, 'tv-movie': 10770,
      thriller: 53, war: 10752, western: 37,
    },
    tv: {
      'action-adventure': 10759, animation: 16, comedy: 35, crime: 80, documentary: 99,
      drama: 18, family: 10751, kids: 10762, mystery: 9648, news: 10763, reality: 10764,
      'sci-fi-fantasy': 10765, soap: 10766, talk: 10767, 'war-politics': 10768, western: 37,
    },
  };
  const SORTS = {
    movie: [
      ['popularity.desc', 'Most Popular'], ['vote_average.desc', 'Highest Rated'],
      ['primary_release_date.desc', 'Newest First'], ['primary_release_date.asc', 'Oldest First'],
      ['revenue.desc', 'Highest Revenue'],
    ],
    tv: [
      ['popularity.desc', 'Most Popular'], ['vote_average.desc', 'Highest Rated'],
      ['first_air_date.desc', 'Newest First'], ['first_air_date.asc', 'Oldest First'],
    ],
  };
  // The site's (movie) sort values, translated for TV discover.
  const tvSortOf = (s) => ({
    'primary_release_date.desc': 'first_air_date.desc',
    'primary_release_date.asc': 'first_air_date.asc',
    'revenue.desc': 'popularity.desc',
  })[s] || s || 'popularity.desc';

  /* ------------------------------------------------------------------ *
   * Helpers                                                              *
   * ------------------------------------------------------------------ */
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k !== null && k !== undefined && k !== false) n.append(k);
    return n;
  };
  const todayISO = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const yearOf = (s) => (s || '').slice(0, 4);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const log = (...a) => console.log(TAG, ...a);

  // Effective bounds: the saved range, with "Hide unreleased" clamping the upper bound to today.
  function effectiveRange() {
    const r = cfg.range;
    let from = isISO(r.from) ? r.from : '';
    let to = isISO(r.to) ? r.to : '';
    if (r.hideUnreleased) {
      const t = todayISO();
      if (!to || to > t) to = t;
    }
    return { from, to, active: !!(from || to) };
  }
  const inRange = (date, rng) => {
    if (!rng.active) return true;
    if (!isISO(date)) return false;            // unknown date never passes an active filter
    if (rng.from && date < rng.from) return false;
    if (rng.to && date > rng.to) return false;
    return true;
  };

  /* ------------------------------------------------------------------ *
   * TMDB                                                                 *
   * ------------------------------------------------------------------ */
  function tmdbFetch(path, params) {
    const key = (cfg.apiKey || '').trim();
    if (!key) return Promise.reject(new Error('No TMDB key set'));
    const u = new URL(TMDB + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== '' && v !== null && v !== undefined) u.searchParams.set(k, v);
    const headers = { accept: 'application/json' };
    // v4 "API Read Access Token" is a JWT (eyJ...); v3 keys are 32 hex chars. Both work.
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
    else u.searchParams.set('api_key', key);
    return fetch(u.toString(), { headers }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.status_message || ('TMDB HTTP ' + r.status));
      return body;
    });
  }

  function discover(ctx, page) {
    const rng = effectiveRange();
    // A year picked on the site (or a /year/{yyyy} page) narrows the range further.
    if (/^\d{4}$/.test(ctx.year || '')) {
      const y0 = ctx.year + '-01-01', y1 = ctx.year + '-12-31';
      if (!rng.from || rng.from < y0) rng.from = y0;
      if (!rng.to || rng.to > y1) rng.to = y1;
    }
    const p = { page, include_adult: 'false', language: 'en-US', sort_by: ctx.sort || 'popularity.desc' };
    if (ctx.genre) p.with_genres = ctx.genre;
    if (ctx.type === 'tv') {
      p.sort_by = tvSortOf(p.sort_by);
      p.include_null_first_air_dates = 'false';
      if (rng.from) p['first_air_date.gte'] = rng.from;
      if (rng.to) p['first_air_date.lte'] = rng.to;
    } else {
      if (rng.from) p['primary_release_date.gte'] = rng.from;
      if (rng.to) p['primary_release_date.lte'] = rng.to;
      // Avoid sorting "newest" on a cloud of placeholder entries with no votes at all.
      if (/_date\./.test(p.sort_by)) p['vote_count.gte'] = '1';
    }
    return tmdbFetch('/discover/' + ctx.type, p);
  }

  /* ------------------------------------------------------------------ *
   * Page context                                                         *
   * ------------------------------------------------------------------ */
  function pageContext() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const sp = new URLSearchParams(location.search);
    const ctx = { listing: false, type: 'movie', genre: '', sort: '', year: '', siteSelects: false, kind: '' };
    let m;
    if (path === '/movies') {
      ctx.listing = true; ctx.kind = 'movies';
      const g = qs('#filterGenre'), y = qs('#filterYear'), s = qs('#filterSortBy');
      ctx.siteSelects = !!(g || y || s);
      ctx.genre = g ? g.value : (sp.get('genre') || '');
      ctx.year = y ? y.value : (sp.get('year') || '');
      ctx.sort = s ? s.value : (sp.get('sort_by') || '');
      if (!ctx.sort && sp.get('sort') === 'top_rated') ctx.sort = 'vote_average.desc';
    } else if (path === '/tv') {
      ctx.listing = true; ctx.kind = 'tv'; ctx.type = 'tv';
      ctx.genre = cfg.tvGenre; ctx.sort = cfg.tvSort;
    } else if ((m = path.match(/^\/genre\/([a-z0-9-]+)$/))) {
      ctx.listing = true; ctx.kind = 'genre';
      ctx.type = sp.get('type') === 'tv' ? 'tv' : 'movie';
      ctx.genre = String(SLUGS[ctx.type][m[1]] || '');
      ctx.sort = ctx.type === 'tv' ? cfg.tvSort : cfg.movieSort;
    } else if ((m = path.match(/^\/year\/(\d{4})$/))) {
      ctx.listing = true; ctx.kind = 'year';
      ctx.type = sp.get('type') === 'tv' ? 'tv' : 'movie';
      ctx.year = m[1];
      ctx.sort = ctx.type === 'tv' ? cfg.tvSort : cfg.movieSort;
    }
    return ctx;
  }

  const findGrid = () => qsa('main .grid').find((g) => qs('a.card', g)) || qs('main .grid');
  function findPager(grid) {
    // The site's pager is the sibling right after the grid: "Page x of y" + Prev/Next .btn links.
    let n = grid && grid.nextElementSibling;
    for (let i = 0; n && i < 3; i++, n = n.nextElementSibling) {
      if (/Page\s+\d+\s+of/.test(n.textContent) && qs('a.btn, span', n)) return n;
    }
    return null;
  }
  const findHeaderCount = () => qsa('main h1 + p').find((p) => /Page\s+\d+\s+of/.test(p.textContent)) || null;

  /* ------------------------------------------------------------------ *
   * Styles                                                               *
   * ------------------------------------------------------------------ */
  const CSS = `
  .hdf-bar{display:flex;flex-wrap:wrap;gap:.625rem;align-items:center;min-width:0;max-width:100%}
  .hdf-bar.hdf-own{padding:1rem;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;margin-bottom:1.5rem}
  .hdf-bar .hdf-sep{flex-basis:100%;height:0}
  .hdf-field{display:inline-flex;align-items:center;gap:.4rem;color:#a0a0c0;font-size:.8125rem;min-width:0}
  .hdf-bar input[type=date],.hdf-bar select.hdf-select{padding:.45rem .6rem;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#fff;font-size:.8125rem;outline:none;color-scheme:dark;min-width:0;max-width:100%}
  .hdf-bar select.hdf-select{min-width:130px;cursor:pointer}
  .hdf-bar input[type=date]{width:10.5rem}
  .hdf-bar input[type=date]:focus,.hdf-bar select.hdf-select:focus{border-color:#6c5ce7}
  .hdf-check{display:inline-flex;align-items:center;gap:.4rem;color:#e8e8f0;font-size:.8125rem;cursor:pointer;user-select:none}
  .hdf-check input{accent-color:#6c5ce7;width:15px;height:15px;margin:0}
  .hdf-btn{padding:.45rem .9rem;border-radius:6px;font-size:.8125rem;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.08);color:#fff;transition:background .2s,border-color .2s;white-space:nowrap}
  .hdf-btn:hover{background:rgba(255,255,255,.14)}
  .hdf-btn.hdf-primary{background:#6c5ce7;border-color:#6c5ce7}
  .hdf-btn.hdf-primary:hover{background:#7d6ff0}
  .hdf-btn.hdf-icon{padding:.4rem .55rem;line-height:0}
  .hdf-btn:disabled{opacity:.45;cursor:not-allowed}
  .hdf-hint{color:#a29bfe;font-size:.8125rem}
  .hdf-hint a,.hdf-hint button{color:#fff;text-decoration:underline;background:none;border:0;padding:0;cursor:pointer;font:inherit}
  .hdf-status{color:#7070a0;font-size:.8125rem;min-width:0;overflow-wrap:anywhere}
  .hdf-status.hdf-err{color:#ff7675}
  .hdf-date{color:#a0a0c0}
  .hdf-date.hdf-future{color:#fdcb6e}
  .hdf-pager{display:flex;align-items:center;justify-content:center;gap:.75rem;flex-wrap:wrap}
  .hdf-pager span{padding:.5rem 1rem;color:#a0a0c0;font-weight:500}
  .hdf-empty{padding:2.5rem 1rem;text-align:center;color:#7070a0;grid-column:1/-1}
  .hdf-search-more{display:block;width:100%;padding:.75rem;text-align:center;background:rgba(108,92,231,.15);color:#a29bfe;border:0;border-top:1px solid rgba(255,255,255,.06);cursor:pointer;font:inherit;font-size:.8125rem}
  .hdf-search-more:hover{background:rgba(108,92,231,.3)}
  .hdf-search-note{padding:.5rem 1.25rem;font-size:.75rem;color:#7070a0;border-bottom:1px solid rgba(255,255,255,.06)}
  .hdf-search-note b{color:#a29bfe;font-weight:600}
  .hdf-search-note button{background:none;border:0;color:#fff;text-decoration:underline;cursor:pointer;font:inherit;padding:0;margin-left:.4rem}

  /* Floating settings panel */
  .hdf-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;box-sizing:border-box;width:340px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);background:#1b1b2f;color:#e8e8f0;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.6);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:hidden;min-width:260px;min-height:0}
  .hdf-panel *{box-sizing:border-box}
  .hdf-panel.hdf-hidden{display:none}
  .hdf-ph{display:flex;align-items:center;gap:.5rem;padding:.6rem .75rem;background:#23233f;border-bottom:1px solid rgba(255,255,255,.08);cursor:move;user-select:none;flex:0 0 auto}
  .hdf-ph b{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hdf-ph small{color:#7070a0;font-weight:400}
  .hdf-pbtn{width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;flex:0 0 auto}
  .hdf-pbtn:hover{background:rgba(255,255,255,.14)}
  .hdf-pb{padding:.75rem;overflow:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:.8rem;flex:1 1 auto;min-height:0}
  .hdf-panel.hdf-collapsed .hdf-pb,.hdf-panel.hdf-collapsed .hdf-rs{display:none}
  .hdf-panel.hdf-collapsed{height:auto !important;width:auto !important;min-width:0}
  .hdf-sec{display:flex;flex-direction:column;gap:.45rem}
  .hdf-sec h4{margin:0;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7070a0;font-weight:600}
  .hdf-sec p{margin:0;color:#a0a0c0;font-size:12px}
  .hdf-sec p a{color:#a29bfe}
  .hdf-row{display:flex;gap:.4rem;align-items:center;min-width:0}
  .hdf-row input[type=text],.hdf-row input[type=password]{flex:1 1 auto;min-width:0;padding:.45rem .6rem;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#fff;font:inherit;outline:none}
  .hdf-row input:focus{border-color:#6c5ce7}
  .hdf-msg{font-size:12px;color:#7070a0;overflow-wrap:anywhere}
  .hdf-msg.hdf-ok{color:#55efc4}
  .hdf-msg.hdf-err{color:#ff7675}
  .hdf-rs{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.25) 50%,rgba(255,255,255,.25) 60%,transparent 60%,transparent 75%,rgba(255,255,255,.25) 75%,rgba(255,255,255,.25) 85%,transparent 85%)}
  `;

  /* ------------------------------------------------------------------ *
   * Settings panel (draggable, resizable, collapsible, persisted)        *
   * ------------------------------------------------------------------ */
  let panel = null, keyInput, keyMsg;

  function buildPanel() {
    if (panel) return panel;
    const title = el('b', null, 'HDToday Date Filter ', el('small', { text: 'v' + VERSION }));
    const btnCollapse = el('button', { class: 'hdf-pbtn', title: 'Collapse / expand', text: cfg.panel.collapsed ? '+' : '–' });
    const btnClose = el('button', { class: 'hdf-pbtn', title: 'Close', text: '×' });
    const head = el('div', { class: 'hdf-ph' }, title, btnCollapse, btnClose);

    keyInput = el('input', { type: 'password', placeholder: 'TMDB API key (v3) or read access token (v4)', autocomplete: 'off', spellcheck: 'false' });
    keyInput.value = cfg.apiKey || '';
    const btnShow = el('button', { class: 'hdf-pbtn', title: 'Show / hide key', text: '●' });
    btnShow.addEventListener('click', () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; });
    keyMsg = el('div', { class: 'hdf-msg', text: cfg.apiKey ? 'Key saved.' : 'No key yet. Listing-page date filters stay off until one is saved.' });
    const btnSave = el('button', { class: 'hdf-btn hdf-primary', text: 'Save' });
    const btnTest = el('button', { class: 'hdf-btn', text: 'Test' });
    const btnForget = el('button', { class: 'hdf-btn', text: 'Forget' });
    btnSave.addEventListener('click', () => {
      cfg.apiKey = keyInput.value.trim(); store.set('apiKey', cfg.apiKey);
      setMsg(keyMsg, cfg.apiKey ? 'Key saved. Reloading page...' : 'Key cleared.', cfg.apiKey ? 'ok' : '');
      if (cfg.apiKey) setTimeout(() => location.reload(), 500); else refreshBarState();
    });
    btnTest.addEventListener('click', async () => {
      const prev = cfg.apiKey; cfg.apiKey = keyInput.value.trim();
      setMsg(keyMsg, 'Testing...');
      try { await tmdbFetch('/configuration'); setMsg(keyMsg, 'Key works. Click Save to keep it.', 'ok'); }
      catch (e) { setMsg(keyMsg, 'TMDB rejected it: ' + e.message, 'err'); }
      cfg.apiKey = prev;
    });
    btnForget.addEventListener('click', () => {
      keyInput.value = ''; cfg.apiKey = ''; store.set('apiKey', '');
      setMsg(keyMsg, 'Key removed from this browser.'); refreshBarState();
    });
    const secKey = el('div', { class: 'hdf-sec' },
      el('h4', { text: 'TMDB key (listing pages)' }),
      el('p', null, 'Free at ', el('a', { href: 'https://www.themoviedb.org/settings/api', target: '_blank', rel: 'noopener', text: 'themoviedb.org > Settings > API' }), '. Stored only in Tampermonkey storage on this browser; sent only to api.themoviedb.org.'),
      el('div', { class: 'hdf-row' }, keyInput, btnShow),
      el('div', { class: 'hdf-row' }, btnSave, btnTest, btnForget),
      keyMsg);

    const chkHideDef = el('input', { type: 'checkbox' }); chkHideDef.checked = !!cfg.hideUnreleasedDefault;
    chkHideDef.addEventListener('change', () => { cfg.hideUnreleasedDefault = chkHideDef.checked; store.set('hideUnreleasedDefault', cfg.hideUnreleasedDefault); });
    const chkShowAll = el('input', { type: 'checkbox' }); chkShowAll.checked = !!cfg.searchShowAll;
    chkShowAll.addEventListener('change', () => { cfg.searchShowAll = chkShowAll.checked; store.set('searchShowAll', cfg.searchShowAll); });
    const btnClearRange = el('button', { class: 'hdf-btn', text: 'Clear saved date range' });
    btnClearRange.addEventListener('click', () => { clearRange(); setMsg(rangeMsg, 'Range cleared.', 'ok'); });
    const rangeMsg = el('div', { class: 'hdf-msg' });
    const secOpts = el('div', { class: 'hdf-sec' },
      el('h4', { text: 'Options' }),
      el('label', { class: 'hdf-check' }, chkHideDef, 'Hide unreleased is on by default (when no range is saved)'),
      el('label', { class: 'hdf-check' }, chkShowAll, 'Search: show all matches instead of the first ' + SEARCH_CAP),
      el('div', { class: 'hdf-row' }, btnClearRange), rangeMsg);

    const secHow = el('div', { class: 'hdf-sec' },
      el('h4', { text: 'How it works' }),
      el('p', { text: 'Set Released from / to in the filter bar on a listing page. Results then come straight from TMDB with full release dates and prev/next paging, using the page\'s genre and sort. The range is remembered until you clear it. The search box filters by date without a key.' }));

    const body = el('div', { class: 'hdf-pb' }, secKey, secOpts, secHow);
    const rs = el('div', { class: 'hdf-rs', title: 'Drag to resize' });
    panel = el('div', { class: 'hdf-panel' + (cfg.panel.collapsed ? ' hdf-collapsed' : '') + (cfg.panel.open ? '' : ' hdf-hidden') }, head, body, rs);
    document.body.appendChild(panel);

    // geometry
    applyPanelGeometry();
    btnCollapse.addEventListener('click', () => {
      cfg.panel.collapsed = !cfg.panel.collapsed; savePanel();
      panel.classList.toggle('hdf-collapsed', cfg.panel.collapsed);
      btnCollapse.textContent = cfg.panel.collapsed ? '+' : '–';
      clampPanel();
    });
    btnClose.addEventListener('click', () => togglePanel(false));

    // drag
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      cfg.panel.x = e.clientX - drag.dx; cfg.panel.y = e.clientY - drag.dy;
      applyPanelGeometry();
    });
    const endDrag = () => { if (drag) { drag = null; clampPanel(); savePanel(); } };
    head.addEventListener('pointerup', endDrag); head.addEventListener('pointercancel', endDrag);

    // resize
    let rz = null;
    rs.addEventListener('pointerdown', (e) => {
      const r = panel.getBoundingClientRect();
      rz = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      try { rs.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
    });
    rs.addEventListener('pointermove', (e) => {
      if (!rz) return;
      cfg.panel.w = Math.max(260, rz.w + (e.clientX - rz.x));
      cfg.panel.h = Math.max(120, rz.h + (e.clientY - rz.y));
      applyPanelGeometry();
    });
    const endRz = () => { if (rz) { rz = null; clampPanel(); savePanel(); } };
    rs.addEventListener('pointerup', endRz); rs.addEventListener('pointercancel', endRz);
    window.addEventListener('resize', clampPanel);
    return panel;
  }
  function applyPanelGeometry() {
    if (!panel) return;
    const p = cfg.panel;
    panel.style.width = (p.w || 340) + 'px';
    panel.style.height = p.h ? p.h + 'px' : '';
    if (p.x === null || p.y === null) { panel.style.right = '16px'; panel.style.top = '80px'; panel.style.left = ''; }
    else { panel.style.left = p.x + 'px'; panel.style.top = p.y + 'px'; panel.style.right = ''; }
  }
  function clampPanel() {
    if (!panel || panel.classList.contains('hdf-hidden')) return;
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = r.left, y = r.top, changed = false;
    if (r.right > vw - 8) { x = Math.max(8, vw - 8 - r.width); changed = true; }
    if (r.bottom > vh - 8) { y = Math.max(8, vh - 8 - r.height); changed = true; }
    if (x < 8) { x = 8; changed = true; }
    if (y < 8) { y = 8; changed = true; }
    if (changed || cfg.panel.x === null) { cfg.panel.x = Math.round(x); cfg.panel.y = Math.round(y); applyPanelGeometry(); }
  }
  function togglePanel(open) {
    buildPanel();
    const want = open === undefined ? panel.classList.contains('hdf-hidden') : !!open;
    panel.classList.toggle('hdf-hidden', !want);
    cfg.panel.open = want; savePanel();
    if (want) { clampPanel(); if (!cfg.apiKey) keyInput.focus(); }
  }
  function setMsg(node, text, kind) {
    node.textContent = text;
    node.className = 'hdf-msg' + (kind ? ' hdf-' + kind : '');
  }

  /* ------------------------------------------------------------------ *
   * Listing pages: filter bar + TMDB-backed grid                         *
   * ------------------------------------------------------------------ */
  let ctx, bar, fromInput, toInput, hideChk, applyBtn, clearBtn, statusEl, hintEl;
  let grid, sitePager, ourPager = null, headerCount, saved = null, curPage = 1;

  function readPageFromHash() {
    const m = location.hash.match(/dfpage=(\d+)/);
    return m ? Math.max(1, parseInt(m[1], 10)) : 1;
  }
  function writePageToHash(p, replace) {
    const h = p > 1 ? '#dfpage=' + p : '';
    const url = location.pathname + location.search + h;
    try { history[replace ? 'replaceState' : 'pushState'](null, '', url); } catch (_) {}
  }

  function buildBar() {
    const siteBar = qs('main .filter-bar');
    bar = el('div', { class: 'hdf-bar' + (siteBar ? '' : ' hdf-own') });

    // Our own genre / sort selects where the site offers none.
    if (!ctx.siteSelects) {
      const genres = ctx.type === 'tv' ? TV_GENRES : MOVIE_GENRES;
      if (ctx.kind !== 'genre') {
        const gsel = el('select', { class: 'hdf-select', title: 'Genre (TMDB)' }, el('option', { value: '', text: 'All Genres' }),
          ...genres.map(([id, name]) => el('option', { value: String(id), text: name })));
        gsel.value = ctx.genre || '';
        gsel.addEventListener('change', () => {
          ctx.genre = gsel.value;
          if (ctx.type === 'tv') { cfg.tvGenre = ctx.genre; store.set('tvGenre', ctx.genre); }
          if (filterActive()) run(1);
        });
        bar.append(gsel);
      }
      const ssel = el('select', { class: 'hdf-select', title: 'Sort (TMDB)' }, ...SORTS[ctx.type].map(([v, name]) => el('option', { value: v, text: name })));
      ssel.value = SORTS[ctx.type].some(([v]) => v === ctx.sort) ? ctx.sort : 'popularity.desc';
      ssel.addEventListener('change', () => {
        ctx.sort = ssel.value;
        if (ctx.type === 'tv') { cfg.tvSort = ctx.sort; store.set('tvSort', ctx.sort); } else { cfg.movieSort = ctx.sort; store.set('movieSort', ctx.sort); }
        if (filterActive()) run(1);
      });
      bar.append(ssel);
    }

    fromInput = el('input', { type: 'date', title: 'Released on or after this date' });
    toInput = el('input', { type: 'date', title: 'Released on or before this date' });
    fromInput.value = cfg.range.from || ''; toInput.value = cfg.range.to || '';
    hideChk = el('input', { type: 'checkbox', title: 'Caps "Released to" at today, so films not out yet are left out' });
    hideChk.checked = !!cfg.range.hideUnreleased;
    applyBtn = el('button', { class: 'hdf-btn hdf-primary', text: 'Apply' });
    clearBtn = el('button', { class: 'hdf-btn', text: 'Clear' });
    const gear = el('button', { class: 'hdf-btn hdf-icon', title: 'Date filter settings (TMDB key)' });
    gear.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    gear.addEventListener('click', () => togglePanel());
    statusEl = el('span', { class: 'hdf-status' });
    hintEl = el('span', { class: 'hdf-hint' }, 'Date filter needs a TMDB key: ', el('button', { type: 'button', text: 'open settings', onclick: () => togglePanel(true) }));

    applyBtn.addEventListener('click', () => {
      cfg.range = { from: fromInput.value, to: toInput.value, hideUnreleased: hideChk.checked };
      if (cfg.range.from && cfg.range.to && cfg.range.from > cfg.range.to) { setStatus('"From" is after "To".', true); return; }
      saveRange();
      if (filterActive()) run(1); else restore();
    });
    hideChk.addEventListener('change', () => applyBtn.click());
    clearBtn.addEventListener('click', clearRange);
    [fromInput, toInput].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBtn.click(); }));

    bar.append(
      el('span', { class: 'hdf-field' }, 'Released from', fromInput),
      el('span', { class: 'hdf-field' }, 'to', toInput),
      el('label', { class: 'hdf-check' }, hideChk, 'Hide unreleased'),
      applyBtn, clearBtn, gear, hintEl, statusEl);

    if (siteBar) siteBar.append(el('span', { class: 'hdf-sep' }), bar);
    else if (grid) grid.parentNode.insertBefore(bar, grid);
    else qs('main .container, main')?.prepend(bar);
    refreshBarState();
  }
  function refreshBarState() {
    if (!bar) return;
    const hasKey = !!(cfg.apiKey || '').trim();
    hintEl.style.display = hasKey ? 'none' : '';
    [fromInput, toInput, hideChk, applyBtn].forEach((i) => { i.disabled = !hasKey; });
    if (!hasKey) setStatus('');
  }
  const filterActive = () => effectiveRange().active;
  function setStatus(text, err) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('hdf-err', !!err);
  }
  function clearRange() {
    cfg.range = { from: '', to: '', hideUnreleased: false }; saveRange();
    if (fromInput) { fromInput.value = ''; toInput.value = ''; hideChk.checked = false; }
    restore();
  }

  function snapshot() {
    if (saved || !grid) return;
    saved = {
      grid: Array.from(grid.childNodes),
      count: headerCount ? headerCount.textContent : null,
    };
  }
  function restore() {
    if (!saved) { setStatus(''); writePageToHash(1, true); return; }
    grid.replaceChildren(...saved.grid);
    if (ourPager) {
      if (sitePager) ourPager.replaceWith(sitePager); else ourPager.remove();
      ourPager = null;
    }
    if (headerCount && saved.count !== null) headerCount.textContent = saved.count;
    saved = null; setStatus(''); writePageToHash(1, true);
    try { W.initWatchlistButtons && W.initWatchlistButtons(); } catch (_) {}
  }

  function card(item) {
    const isTv = ctx.type === 'tv';
    const id = item.id;
    const title = item.title || item.name || 'Untitled';
    const date = item.release_date || item.first_air_date || '';
    const poster = item.poster_path ? IMG + 'w342' + item.poster_path : '';
    const href = (isTv ? '/tv/' : '/movie/') + id;
    const future = isISO(date) && date > todayISO();

    const wl = el('button', { class: 'watchlist-btn', 'aria-label': 'Add ' + title + ' to watchlist', 'data-id': (isTv ? 'tv-' : 'movie-') + id });
    wl.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>';
    wl.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { W.toggleWatchlist && W.toggleWatchlist(isTv ? 'tv' : 'movie', id, title, poster); } catch (_) {}
    });
    const img = poster
      ? el('img', { src: poster, alt: 'Watch ' + title + (date ? ' (' + yearOf(date) + ')' : '') + ' online free in HD', width: '342', height: '513', loading: 'lazy' })
      : el('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7070a0;font-size:.75rem;padding:.5rem;text-align:center', text: 'No poster' });
    const badge = el('span', { class: 'card-badge badge-hd', text: future ? 'Soon' : 'HD' });
    if (future) { badge.style.background = 'rgba(253,203,110,.85)'; badge.style.color = '#1a1a3e'; }
    const overlay = el('div', { class: 'card-overlay' }, el('span', { class: 'play-btn' }));
    qs('.play-btn', overlay).innerHTML = '<svg width="22" height="22" fill="#fff" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    const rating = item.vote_average ? Number(item.vote_average).toFixed(1) : '';
    const typeTag = el('span', {
      style: 'display:inline-block;padding:.125rem .4375rem;font-size:.625rem;font-weight:600;border-radius:3px;letter-spacing:.02em;' +
        (isTv ? 'background:rgba(52,152,219,.3);color:#85c1e9' : 'background:rgba(108,92,231,.3);color:#a29bfe'),
      text: isTv ? 'TV' : 'Movie',
    });
    return el('a', { href, class: 'card', title: title + (date ? ' (' + date + ')' : '') },
      wl,
      el('div', { class: 'card-img' }, img, badge, overlay),
      el('div', { class: 'card-info' },
        el('h3', { class: 'text-white truncate', text: title }),
        el('div', { class: 'flex items-center gap-2 mt-1 text-xs flex-wrap' },
          el('span', { class: 'hdf-date' + (future ? ' hdf-future' : ''), text: date || 'Date unknown' }),
          typeTag,
          rating ? el('span', { class: 'text-zinc-500', text: rating + ' / 10' }) : null)));
  }

  function renderPager(page, totalPages, totalResults) {
    const max = Math.min(totalPages || 1, TMDB_MAX_PAGES);
    const prev = el('button', { class: 'btn btn-secondary btn-sm hdf-prev', text: 'Prev' });
    const next = el('button', { class: 'btn btn-secondary btn-sm hdf-next', text: 'Next' });
    prev.disabled = page <= 1; next.disabled = page >= max;
    prev.addEventListener('click', () => run(page - 1, { push: true, scroll: true }));
    next.addEventListener('click', () => run(page + 1, { push: true, scroll: true }));
    const node = el('div', { class: 'hdf-pager flex items-center justify-center gap-3' },
      prev, el('span', { text: 'Page ' + page + ' of ' + max + (totalResults ? ' (' + totalResults.toLocaleString() + ' titles)' : '') }), next);
    if (ourPager) ourPager.replaceWith(node);
    else if (sitePager) sitePager.replaceWith(node);
    else grid.after(node);
    ourPager = node;
    return node;
  }

  let inflight = 0;
  async function run(page, opts) {
    opts = opts || {};
    if (!grid) return;
    if (!(cfg.apiKey || '').trim()) { refreshBarState(); return; }
    const rng = effectiveRange();
    if (!rng.active) { restore(); return; }
    snapshot();
    curPage = page;
    if (!opts.fromHistory) writePageToHash(page, !opts.push);
    const seq = ++inflight;
    setStatus('Loading from TMDB...');
    grid.style.opacity = '.5';
    try {
      const data = await discover(ctx, page);
      if (seq !== inflight) return;
      const items = data.results || [];
      grid.replaceChildren(...(items.length ? items.map(card) : [el('div', { class: 'hdf-empty', text: 'No titles match this date range.' })]));
      renderPager(data.page || page, data.total_pages || 1, data.total_results || 0);
      if (headerCount) headerCount.textContent = 'Page ' + (data.page || page) + ' of ' + Math.min(data.total_pages || 1, TMDB_MAX_PAGES) + ' (TMDB, date filtered)';
      const desc = (rng.from ? 'from ' + rng.from + ' ' : '') + (rng.to ? 'to ' + rng.to : '');
      setStatus('Showing TMDB results ' + desc.trim() + (cfg.range.hideUnreleased ? ' (unreleased hidden)' : ''));
      try { W.initWatchlistButtons && W.initWatchlistButtons(); } catch (_) {}
      if (opts.scroll) grid.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) {
      if (seq !== inflight) return;
      setStatus('TMDB error: ' + e.message, true);
      log('discover failed', e);
    } finally {
      if (seq === inflight) grid.style.opacity = '';
    }
  }

  /* ------------------------------------------------------------------ *
   * Search modal: date-filter /api/search client-side                    *
   * ------------------------------------------------------------------ */
  let searchTimer = null, lastQuery = '', showAllOnce = false;
  function installSearch() {
    const results = qs('#searchResults');
    if (!results || typeof W.doSearch !== 'function') return;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    W.doSearch = function (q) {
      clearTimeout(searchTimer);
      if (q !== lastQuery) showAllOnce = false;
      lastQuery = q;
      if (!q || q.length < 2) { results.innerHTML = '<p class="search-hint">Start typing to search...</p>'; return; }
      results.innerHTML = '<p class="search-hint">Searching...</p>';
      searchTimer = setTimeout(async () => {
        try {
          const r = await fetch('/api/search?q=' + encodeURIComponent(q));
          const d = await r.json();
          renderSearch(d.results || [], q);
        } catch (e) {
          results.innerHTML = '<p class="search-hint" style="color:#6c5ce7">Search failed</p>';
        }
      }, 300);
    };

    function renderSearch(all, q) {
      const rng = effectiveRange();
      const matched = all.filter((i) => inRange(i.release_date || i.first_air_date, rng));
      const showAll = cfg.searchShowAll || showAllOnce;
      const shown = showAll ? matched : matched.slice(0, SEARCH_CAP);
      results.replaceChildren();
      if (rng.active) {
        const note = el('div', { class: 'hdf-search-note' });
        note.append(el('b', { text: matched.length + ' of ' + all.length }), ' results released ' +
          (rng.from ? 'from ' + rng.from + ' ' : '') + (rng.to ? 'to ' + rng.to : ''));
        const clr = el('button', { type: 'button', text: 'Clear range' });
        clr.addEventListener('click', () => { clearRange(); W.doSearch(q); });
        note.append(clr);
        results.append(note);
      }
      if (!shown.length) { results.append(el('p', { class: 'search-hint', text: all.length ? 'No results in this date range' : 'No results found' })); return; }
      for (const i of shown) {
        const isMovie = i.media_type === 'movie';
        const title = i.title || i.name || '';
        const date = i.release_date || i.first_air_date || '';
        const poster = i.poster_path ? IMG + 'w92' + i.poster_path : '';
        const url = isMovie ? '/movie/' + i.id : '/tv/' + i.id;
        const future = isISO(date) && date > todayISO();
        const a = el('a', { href: url, class: 'search-item' });
        a.addEventListener('click', () => { try { W.closeSearch && W.closeSearch(); } catch (_) {} });
        a.innerHTML = '<img src="' + esc(poster) + '" alt="Watch ' + esc(title) + ' online free" width="45" height="68">' +
          '<div style="min-width:0"><p class="text-sm font-semibold text-white truncate">' + esc(title) + '</p>' +
          '<p class="text-xs text-zinc-500"><span class="hdf-date' + (future ? ' hdf-future' : '') + '">' + (date ? esc(date) : 'Date unknown') + '</span>' +
          ' · ' + (isMovie ? 'Movie' : 'TV Show') + (i.vote_average ? ' · ' + Number(i.vote_average).toFixed(1) : '') + '</p></div>';
        results.append(a);
      }
      if (!showAll && matched.length > SEARCH_CAP) {
        const more = el('button', { class: 'hdf-search-more', type: 'button', text: 'Show all ' + matched.length + ' results' });
        more.addEventListener('click', () => { showAllOnce = true; renderSearch(all, q); });
        results.append(more);
      }
    }
    log('search hook installed');
  }

  /* ------------------------------------------------------------------ *
   * Boot                                                                 *
   * ------------------------------------------------------------------ */
  function boot() {
    document.head.appendChild(el('style', { text: CSS }));
    try {
      GM_registerMenuCommand('HDToday Date Filter: settings', () => togglePanel(true));
      GM_registerMenuCommand('HDToday Date Filter: clear date range', () => clearRange());
    } catch (_) {}
    if (cfg.panel.open) buildPanel();

    installSearch();

    ctx = pageContext();
    if (ctx.listing) {
      grid = findGrid();
      sitePager = findPager(grid);
      headerCount = findHeaderCount();
      buildBar();
      window.addEventListener('popstate', () => { if (saved) run(readPageFromHash(), { fromHistory: true }); });
      if (filterActive() && (cfg.apiKey || '').trim()) run(readPageFromHash());
    }
    log('v' + VERSION + ' active', ctx.listing ? '(listing: ' + ctx.kind + '/' + ctx.type + ')' : '');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
