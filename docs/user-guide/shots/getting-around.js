// Shots for content/getting-around.json — "Finding your way around".
// Theme is dark throughout per the chapter table. Desktop 1440x900.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { LIB } = world;

const MY = { memex_library_id: LIB.jordan };

// Hide what sits under the top bar (the Home page and the rail), so a crop that
// reaches below the bar for its badges shows plain background there.
async function hideBelowBar(page) {
  await page.eval(() => {
    document.querySelectorAll('#file-home-main, .file-home-nav').forEach((el) => { el.style.visibility = 'hidden'; });
    return true;
  });
}
// A fixed marker around one element, with its own pad on each side, for `clip`.
async function markAround(page, sel, pad) {
  await page.eval((sel, pad) => {
    document.getElementById('__clipmark')?.remove();
    const r = document.querySelector(sel).getBoundingClientRect();
    const m = document.createElement('div');
    m.id = '__clipmark';
    m.style.cssText = `position:fixed;left:${Math.max(0, r.left - pad.left)}px;top:${Math.max(0, r.top - pad.top)}px;width:${r.width + pad.left + pad.right}px;height:${r.height + pad.top + pad.bottom}px;pointer-events:none`;
    document.body.appendChild(m);
    return true;
  }, sel, pad);
}

module.exports = [
  // The top bar, in two tight crops instead of one: the whole 1440px bar printed at
  // 6.5in wide shrank every on-screen label to 3-4pt (QA). Each crop is a fixed marker
  // around just its part of the bar, with room underneath for the badges (place 'b').
  // The page content under the bar is hidden while the picture is taken, so the badges
  // sit on plain background instead of on the Home greeting or the rail's heading.
  {
    id: 'topbar-search', theme: 'dark', route: '#/home', localStorage: MY,
    setup: async (page) => { await settle(page); await hideBelowBar(page); await markAround(page, '.masthead-search', { top: 12, right: 16, bottom: 48, left: 16 }); },
    clip: { selector: '#__clipmark', pad: 0 },
    callouts: [
      { n: 1, selector: '#global-search', place: 'b' },
    ],
    caption: 'The search box at the left of the top bar',
  },
  {
    id: 'topbar-icons', theme: 'dark', route: '#/home', localStorage: MY,
    setup: async (page) => { await settle(page); await hideBelowBar(page); await markAround(page, '.masthead-actions', { top: 12, right: 16, bottom: 48, left: 16 }); },
    clip: { selector: '#__clipmark', pad: 0 },
    callouts: [
      // No outline boxes: the four controls sit close together, so boxes overlapped
      // each other and hid the bell's unread count. Each badge sits right under its icon.
      { n: 1, selector: '#status-pill', place: 'b', box: false },
      { n: 2, selector: '#meet-btn', place: 'b', box: false },
      { n: 3, selector: '#notif-btn', place: 'b', box: false },
      { n: 4, selector: 'button[title="Settings"]', place: 'b', box: false },
    ],
    caption: 'The right side of the top bar: status, meetings, notifications and settings',
  },
  // The theme toggle and the user chip, at the right-hand end of the same bar.
  {
    id: 'topbar-you', theme: 'dark', route: '#/home', localStorage: MY, setup: settle,
    clip: { selector: '.masthead-actions', pad: 20 },
    callouts: [
      { n: 1, selector: '#theme-btn', place: 'b' },
      { n: 2, selector: '#user-chip', place: 'b' },
    ],
    caption: 'The theme toggle and your name, at the right of the top bar',
  },
  // The left rail: library switcher plus the main nav links (Home stays the active view
  // so the folder tree under Files does not open and crowd the picture).
  {
    id: 'rail', theme: 'dark', route: '#/home', localStorage: MY, setup: settle,
    // .file-home-nav stretches to fill the viewport (overflow-y:auto), so a selector
    // clip on it would grab the whole 900px column. A fixed clip keeps just the
    // switcher, pinned libraries and the nav links through Shared with me / My links / Trash.
    clip: { x: 0, y: 40, width: 280, height: 450 },
    callouts: [
      { n: 1, selector: '.file-library-heading', place: 'r' },
      { n: 2, selector: '.file-nav-link[data-view="home"]', place: 'r' },
      { n: 3, selector: '.file-nav-link[data-view="active"]', place: 'r' },
      { n: 4, selector: '.file-nav-link[data-view="favorites"]', place: 'r' },
      { n: 5, selector: '.file-nav-link[data-view="shared"]', place: 'r' },
    ],
    caption: 'The left rail: the library switcher and main navigation',
  },
  // The Home dashboard's stat strip, cropped to just the four tiles. Each badge sits
  // right after its own tile's label (Files, Storage, Shared, Libraries), inside that
  // tile, with no outline box: outlines around four touching tiles doubled up on the
  // dividers, and badges under the tiles read as sitting between two of them (QA).
  {
    id: 'home-stats', theme: 'dark', route: '#/home', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      // The label spans stretch across their column; shrink-wrap them (no visual change,
      // the text is left-aligned) so each badge lands right after the word itself.
      await page.eval(() => { document.querySelectorAll('.dash-stat-label').forEach((el) => { el.style.alignSelf = 'flex-start'; }); return true; });
      await markAround(page, '.dash-stats', { top: 16, right: 16, bottom: 16, left: 16 });
    },
    clip: { selector: '#__clipmark', pad: 0 },
    callouts: [
      { n: 1, selector: '.dash-stats .dash-stat:nth-child(1) .dash-stat-label', place: 'r', box: false },
      { n: 2, selector: '.dash-stats .dash-stat:nth-child(2) .dash-stat-label', place: 'r', box: false },
      { n: 3, selector: '.dash-stats .dash-stat:nth-child(3) .dash-stat-label', place: 'r', box: false },
      { n: 4, selector: '.dash-stats .dash-stat:nth-child(4) .dash-stat-label', place: 'r', box: false },
    ],
    caption: 'The Home dashboard: Files, Storage, Shared and Libraries',
  },
  // "Your libraries", the first card in the main column. Cropped to just that card
  // (not the full-width row) so it can't be confused with Notifications, which sat
  // right next to it in the old full-page shot with callout 5 on their shared
  // border -- this crop doesn't reach Notifications' left edge (x=996) at all. The
  // top edge (y=344) sits in the 1px gap between the "Needs attention" bar above
  // (bottom y=344) and the callout badge (top y=345), and the bottom edge stays
  // clear of the "Shared with you" card 20px below (top y=579). The whole card is
  // outlined, with the badge at its top-right corner, clear of the card's own
  // header.
  {
    id: 'home-libraries', theme: 'dark', route: '#/home', localStorage: MY, setup: settle,
    clip: { x: 264, y: 344, width: 731, height: 230 },
    callouts: [
      { n: 1, selector: '.dash-main .dash-card:nth-of-type(1)', place: 'tr' },
    ],
    caption: 'The Home dashboard: Your libraries',
  },
  // The library switcher open: switching to a shared library, and pinning one that
  // is not pinned yet (Finance — Client Projects and Marketing are already pinned).
  {
    id: 'library-switcher', theme: 'dark', route: '#/home', localStorage: MY,
    setup: async (page) => { await settle(page); await page.click('.file-library-heading'); await sleep(500); },
    // The open menu is position:absolute, so it does not enlarge .library-switch-wrap's
    // own box — a selector clip on the wrap would crop to just the closed heading.
    // A fixed clip over the rail's top-left corner keeps the heading, My libraries and
    // Shared with me through "See everything shared with you", stopping cleanly before
    // the Share / Who has access / Rename / New library rows further down.
    clip: { x: 0, y: 40, width: 280, height: 380 },
    callouts: [
      { n: 1, selector: '.file-library-heading', place: 'r' },
      { n: 2, selector: `.library-menu-item[onclick="switchLibrary('${LIB.marketing}')"]`, place: 'r' },
      { n: 3, selector: '.library-pin-star[aria-label="Pin Finance"]', place: 'l' },
    ],
    caption: 'The library switcher open: switch libraries or pin one to the rail',
  },
];
