// Shots for "Searching and asking questions" (id search-ai, part 1, chapter 10, theme dark).
//   node capture/run.js search-ai
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { F, LIB } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };

// The Upload/scope menus are position:absolute, so their own selector's bounding
// box does not include what is open next to or below them, and a plain full-row
// clip would drag in table columns we don't want. Both shots below drop a fixed
// marker sized to a custom-computed box (plus a margin) so `clip` can crop to
// exactly the parts we want, instead of the whole viewport. (Same technique as
// shots/upload.js's markClipAround helper.)
const MARKER = { selector: '#__clip_marker', pad: 0 };

const PROPOSAL = F['Northfield Clinic proposal'].id;
const AGREEMENT = F['Northfield Clinic service agreement'].id;

module.exports = [
  // 1. Type in the search box: "scheduling" only appears in the Northfield
  // Clinic proposal's text, not its file name, so the one result proves the
  // search reached inside the file rather than just matching names.
  {
    id: 'search-results',
    theme: 'dark',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click('#global-search');
      await page.type('scheduling');
      await page.key('Enter');
      await sleep(700);
      // The row is a full table row (Name/Size/Modified/Actions), so a plain
      // markClipAround on it would drag those columns in too and stretch the crop
      // out to almost the full 1440px width -- shrinking the text far below a
      // legible print size. Crop instead to the search bar and just the matched
      // file's visible name text (using scrollWidth, since the name cell itself
      // is stretched full width by the table layout and is not a true measure
      // of the text).
      await page.eval((barSel, rowSel, pad) => {
        const bar = document.querySelector(barSel).getBoundingClientRect();
        const row = document.querySelector(rowSel);
        const rowRect = row.getBoundingClientRect();
        const textRight = (el) => el ? el.getBoundingClientRect().left + Math.min(el.scrollWidth, 560) : 0;
        const left = Math.min(bar.left, rowRect.left) - pad;
        const top = Math.min(bar.top, rowRect.top) - pad;
        const right = Math.max(bar.right, textRight(row.querySelector('.file-row-title')), textRight(row.querySelector('.file-row-sub'))) + pad;
        const bottom = rowRect.bottom + pad;
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        m.style.left = Math.max(0, left) + 'px'; m.style.top = Math.max(0, top) + 'px';
        m.style.width = (right - Math.max(0, left)) + 'px'; m.style.height = (bottom - Math.max(0, top)) + 'px';
      }, '.masthead-search', `tr[data-fid="${PROPOSAL}"]`, 24);
    },
    clip: MARKER,
    callouts: [
      { n: 1, selector: '#global-search', place: 'b' },
      { n: 2, selector: `tr[data-fid="${PROPOSAL}"] .file-row-title`, place: 'b' },
    ],
    caption: 'Typing a search finds a word inside a file, not just in its name',
  },
  // 2. The combined scope menu, open: the four search choices sit above the
  // separate "AI model" section (which is admin-only and out of scope for this
  // guide), so the clip marker stops right after the fourth scope item.
  {
    id: 'search-scope',
    theme: 'dark',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click('#search-control-btn');
      await sleep(300);
      // Hide the Home page under the open menu, so the part of the crop beside and below
      // the menu is plain background, not a sliced-off greeting and Storage tile (QA).
      await page.eval(() => { const m = document.getElementById('file-home-main'); if (m) m.style.visibility = 'hidden'; return true; });
      // The scope button and the search input share one rounded pill
      // (.masthead-search), only 8px apart, so callout 1's badge (placed to
      // the right of the button) unavoidably sits on top of the start of the
      // input's placeholder text. Cutting the crop's right edge anywhere
      // between the badge and the end of that pill sliced through live
      // placeholder text and its rounded corner, so the crop now runs past
      // the whole pill instead (full box, full "Search or ask Depot..."
      // text, rounded corner and all). The bottom stays tied to the fourth
      // scope item so the crop still ends right after it, before the
      // separate "AI model" section (that picker only works for admins and
      // is out of scope here).
      await page.eval((btnSel, itemSel, pillSel) => {
        const b = document.querySelector(btnSel).getBoundingClientRect();
        const i = document.querySelector(itemSel).getBoundingClientRect();
        const p = document.querySelector(pillSel).getBoundingClientRect();
        const left = Math.min(b.left, i.left) - 16, top = Math.min(b.top, i.top) - 16;
        const right = Math.max(i.right + 48, p.right + 16), bottom = i.bottom + 6;
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        m.style.left = Math.max(0, left) + 'px'; m.style.top = Math.max(0, top) + 'px';
        m.style.width = (right - Math.max(0, left)) + 'px'; m.style.height = (bottom - Math.max(0, top)) + 'px';
      }, '#search-control-btn', '#search-control-menu .search-scope-item:nth-of-type(4)', '.masthead-search');
    },
    clip: MARKER,
    callouts: [
      { n: 1, selector: '#search-control-btn', place: 'r' },
      { n: 2, selector: '#search-control-menu .search-scope-item:nth-of-type(1)', place: 'r' },
      { n: 3, selector: '#search-control-menu .search-scope-item:nth-of-type(2)', place: 'r' },
      { n: 4, selector: '#search-control-menu .search-scope-item:nth-of-type(3)', place: 'r' },
      { n: 5, selector: '#search-control-menu .search-scope-item:nth-of-type(4)', place: 'r' },
    ],
    caption: 'The scope button open: Auto, Contents, File names and Ask AI',
  },
  // 3. A plain-word question, typed in the search box and submitted with Enter:
  // Auto recognises it as a question and opens "Ask the collection" itself.
  {
    id: 'ask-window',
    theme: 'dark',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click('#global-search');
      await page.type('What does the Northfield Clinic proposal cost?');
      await page.key('Enter');
      await sleep(900);
    },
    clip: { selector: '.file-ask-modal', pad: 20 },
    callouts: [
      { n: 1, selector: '#file-collection-question', place: 'tr' },
      { n: 2, selector: '#file-collection-answer', place: 'b' },
      { n: 3, selector: '.file-ask-modal .btn-row .ghost-btn:last-of-type', place: 'r' },
    ],
    caption: 'The Ask window: it repeats the question, then answers underneath',
  },
  // 4. Asking about selected files: two files chosen directly (the same state
  // reached from the selection bar's "Ask Claude", a file's "Ask about this
  // file", or its row menu's "Ask AI about this"), with a question asked and
  // its answer streamed in.
  // Left out of content/search-ai.json on purpose: the window's own subtitle and
  // submit button name a real AI product ("Claude will answer...", "Ask Claude",
  // hard-coded in index.html), and the brief allows no real company names. Don't
  // wire it into a section until the app's labels change; relabelling them here
  // would show readers a button their screen doesn't have.
  {
    id: 'ask-selected',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval((ids) => { selectedFileIds = new Set(ids); openAskSelected(); }, [PROPOSAL, AGREEMENT]);
      await sleep(300);
      await page.click('#file-ask-question');
      await page.type('When does the Northfield Clinic project start, and who signs the agreement?');
      await page.click('.file-ask-modal .run-btn');
      await sleep(900);
    },
    clip: { selector: '.file-ask-modal', pad: 20 },
    callouts: [
      { n: 1, selector: '.file-ask-docs', place: 'r' },
      { n: 2, selector: '#file-ask-question', place: 'tr' },
      { n: 3, selector: '.file-ask-modal .run-btn', place: 't' },
      { n: 4, selector: '#file-ask-answer', place: 'b' },
    ],
    caption: 'Asking a question about two selected files only',
  },
];
