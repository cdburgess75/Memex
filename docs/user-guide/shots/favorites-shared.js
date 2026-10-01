// Shots for content/favorites-shared.json — "Favorites and files shared with you"
// (part 1, chapter 11, theme light). Desktop 1440x900.
//   node capture/run.js favorites-shared
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { F, LIB } = world;

const MY = { memex_library_id: LIB.jordan };
const Q3_REVIEW = F['Q3 review'].id; // Jordan Lee / Q3 review.pptx — not starred in base.js

module.exports = [
  // 1. Point to an un-starred file to reveal its star, and where Favorites lives in the
  // rail. Needs a full-viewport clip: a screenshot with no clip drops :hover in headless
  // Chrome, and this picture needs both the row (mid-page) and the rail (left edge).
  {
    id: 'star',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => { await settle(page); await page.hover(`tr[data-fid="${Q3_REVIEW}"]`); },
    clip: { x: 0, y: 0, width: 1440, height: 900 },
    caption: 'Pointing to a file to reveal its star, and Favorites in the left rail',
    callouts: [
      { n: 1, selector: `tr[data-fid="${Q3_REVIEW}"] .file-fav-btn`, place: 't' },
      { n: 2, selector: '.file-nav-link[data-view="favorites"]', place: 'r' },
    ],
  },
  // 1b. The same hovered row, cropped tight to its right-hand end (Size, Modified and the
  // row icons) so the star prints large. The full-screen 'star' shot above shrank the
  // star to a few pixels on the printed page. The crop reaches up into the row above
  // (Q3 budget.xlsx) only far enough to give badge 1 room above the star.
  {
    id: 'star-row',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.hover(`tr[data-fid="${Q3_REVIEW}"]`);
      await sleep(200);
      await page.eval((rowSel) => {
        const row = document.querySelector(rowSel);
        const size = row.querySelector('.file-col-size').getBoundingClientRect();
        const acts = row.querySelector('.file-col-actions').getBoundingClientRect();
        const r = row.getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const left = size.left - 20, top = r.top - 40, right = acts.right + 20, bottom = r.bottom + 12;
        m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.width = (right - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      }, `tr[data-fid="${Q3_REVIEW}"]`);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'Pointing to a file to reveal the star on its row',
    callouts: [
      { n: 1, selector: `tr[data-fid="${Q3_REVIEW}"] .file-fav-btn`, place: 't' },
    ],
  },
  // 2. Quick access, further down the rail: the "Quick access" heading plus the grouped
  // list of recently-opened files (base.js gives it 8, spread across Today/Yesterday/…).
  // pad 44 on the list pulls in the heading sitting just above it (margin 8px + ~18px text).
  {
    id: 'quick-access',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: settle,
    clip: { selector: '#file-quick-list', pad: 44 },
    caption: 'Quick access, grouped by when you last opened each file',
    callouts: [
      { n: 1, selector: '#file-quick-list .file-quick-pill', place: 'r' },
    ],
  },
  // 3. The Shared with me page: only the rail's "Shared with me" item and the Libraries
  // table matter here (Finance and the highlighted Marketing row, from sharedWithMe() in
  // base.js). A full 1440x900 shot buried them in the top bar, Quick access, Connections
  // and the Folders / Files-given-to-you tables further down, shrinking the readable
  // text a lot once the page laid it out at 6.5in wide. Mark a manual region instead:
  // the rail from the "Marketing" pinned item down through "Shared with me" (a run of
  // whole buttons, nothing cut off at either edge) and the Libraries table's Name and
  // Permission columns (Size, Updated and Owner run off the right, out of frame).
  {
    id: 'shared-with-me',
    theme: 'light',
    route: '#/shared',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => {
        const shared = document.querySelector('.file-nav-link[data-view="shared"]');
        const sections = document.querySelectorAll('.swm-section');
        const table = sections[0]?.querySelector('.file-table-wrap');
        const permCol = sections[0]?.querySelectorAll('thead th')[1];
        if (!shared || !table || !permCol) return;
        const sr = shared.getBoundingClientRect(), tr = table.getBoundingClientRect(), pr = permCol.getBoundingClientRect();
        // Stop 2px past the Permission column: 16px reached into the next column's header
        // and left a lone 'S' of 'Size' at the picture's right edge (QA).
        const left = 0, top = Math.round(tr.top), right = Math.round(pr.right) + 2;
        // The Folders section heading (right column) starts a couple of px above where the
        // rail's "Shared with me" button (left column) ends, so there is no padding to
        // spare below the button: stop right at its real bottom edge (its callout below
        // skips the usual highlight box, which would otherwise need 4 more px than that).
        const bottom = Math.round(sr.bottom);
        let m = document.getElementById('__swm_clip');
        if (!m) { m = document.createElement('div'); m.id = '__swm_clip'; m.style.cssText = 'position:fixed;pointer-events:none'; document.body.appendChild(m); }
        m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.width = (right - left) + 'px'; m.style.height = (bottom - top) + 'px';
      });
    },
    clip: { selector: '#__swm_clip', pad: 0 },
    caption: 'The Shared with me page: the Libraries table, and Shared with me in the left rail',
    callouts: [
      { n: 1, selector: '.file-nav-link[data-view="shared"]', place: 'r', box: false },
      { n: 2, selector: `tr[data-swm-lib="${LIB.marketing}"] .swm-name`, place: 't' },
    ],
  },
  // 4. What a colleague sees after signing in to a link you sent them: a plain box with
  // who sent it and that it is view only, plus Download. No callouts — an illustration,
  // like open-edit's preview-pdf shot.
  {
    id: 'colleague-link',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => openSigninLink('/files/signin-link/demo-token'));
      await page.waitFor('#sl-title');
      await sleep(300);
    },
    clip: { selector: '#signin-link-scrim .modal', pad: 24 },
    caption: 'What a colleague sees after signing in to a file you sent them',
  },
];
