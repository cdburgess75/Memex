// Shots for content/phone.json — "Depot on your phone" (part 2, chapter 18).
// Theme is light throughout per the chapter table. Device is phone (390x844) for
// every shot here, the one chapter that shows the phone layout.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { LIB } = world;

const MY = { memex_library_id: LIB.jordan };
const UPLOAD_BTN = '#file-library-commandbar .masthead-upload-secondary';

// The account menu is a fixed-position sheet pinned under the header on phones, so
// neither the header's own box nor the user-chip's box covers both it and the menu.
// Drop a fixed marker sized to the union of the two (plus a margin) so `clip` can
// crop to "top bar + open menu" instead of the whole phone screen. Matches the
// pattern in shots/upload.js and shots/organise.js.
async function markClipAround(page, selectors, pad = 20) {
  await page.eval((sels, pad) => {
    const rects = sels.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter(Boolean);
    if (!rects.length) return;
    const left = Math.min(...rects.map((r) => r.left)) - pad;
    const top = Math.min(...rects.map((r) => r.top)) - pad;
    const right = Math.max(...rects.map((r) => r.right)) + pad;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
    let m = document.getElementById('__clip_marker');
    if (!m) {
      m = document.createElement('div');
      m.id = '__clip_marker';
      m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1';
      document.body.appendChild(m);
    }
    m.style.left = Math.max(0, left) + 'px';
    m.style.top = Math.max(0, top) + 'px';
    m.style.width = (right - Math.max(0, left)) + 'px';
    m.style.height = (bottom - Math.max(0, top)) + 'px';
  }, selectors, pad);
}

module.exports = [
  // Home on a phone, with the account menu open: this is where the theme switch
  // moves to once the top bar drops the sun/moon icon to fit one row. Clipped to
  // the top bar plus the open menu so this prints large enough to read: the two
  // steps beside it only need that part of the screen, not the whole dashboard.
  {
    id: 'home',
    theme: 'light',
    device: 'phone',
    route: '#/home',
    setup: async (page) => {
      await settle(page);
      await page.click('#user-chip');
      await sleep(400);
      // Hide the Home page under the open menu: the crop's bottom margin otherwise
      // caught the top half of the "Good evening, Jordan Lee" greeting.
      await page.eval(() => { const m = document.getElementById('file-home-main'); if (m) m.style.visibility = 'hidden'; return true; });
      await markClipAround(page, ['.masthead', '#app-menu']);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'Home on a phone, with the account menu open',
    callouts: [
      { n: 1, selector: '#user-chip', place: 'b' },
      { n: 2, selector: '#app-menu .app-menu-item.phone-only', place: 'r' },
    ],
  },
  // The Files page on a phone: the file list becomes a stack of rows, and the
  // Upload menu (same menu as on a computer) opens a phone's own file/photo picker.
  {
    id: 'files',
    theme: 'light',
    device: 'phone',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(UPLOAD_BTN);
      await sleep(300);
    },
    caption: 'The Files page on a phone, with the Upload menu open',
    callouts: [
      { n: 1, selector: UPLOAD_BTN, place: 't' },
      { n: 2, selector: '#file-upload-menu button[onclick*="chooseUpload(\'files\')"]', place: 'r' },
    ],
  },
];
