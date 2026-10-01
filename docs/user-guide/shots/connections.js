// Shots for "SharePoint and Windows file shares" (part 2, chapter 17, theme dark).
// Acme Intranet (SharePoint) shows the browse/add/share flow; Office file server
// (Windows) is marked delegated in demo/fixtures/connections.js so it can show the
// personal-share Unlock dialog. All three shots are dark, 1440x900, per the brief.
'use strict';
const { settle } = require('../demo/fixtures/base');
const { SP_ID, SMB_ID, LOCK_SENTINEL } = require('../demo/fixtures/connections');
const { sleep } = require('../capture/cdp');

const FULL = { x: 0, y: 0, width: 1440, height: 900 };
const FILE = 'Staff handbook.docx';
const DOWNLOAD_BTN = `[onclick*="mountDownload"][data-path="${FILE}"]`;
const SHARE_BTN = `[onclick^="mountShare"][data-path="${FILE}"]`;

// The Share menu is a position:fixed element appended to <body> next to the button
// that opened it, so neither element's own bounding box covers both — build a clip
// marker sized to their union (same trick shots/upload.js uses for its dropdowns).
async function markClipAround(page, selectors, pad = 40) {
  await page.eval((sels, pad) => {
    const rects = sels.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter(Boolean);
    if (!rects.length) return;
    const left = Math.min(...rects.map((r) => r.left)) - pad;
    const top = Math.min(...rects.map((r) => r.top)) - pad;
    const right = Math.max(...rects.map((r) => r.right)) + pad;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
    let m = document.getElementById('__clip_marker');
    if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
    m.style.left = Math.max(0, left) + 'px'; m.style.top = Math.max(0, top) + 'px';
    m.style.width = (right - Math.max(0, left)) + 'px'; m.style.height = (bottom - Math.max(0, top)) + 'px';
  }, selectors, pad);
}

module.exports = [
  // A SharePoint library's root: the rail entry, the Upload/New folder toolbar, and
  // one file's row actions (Download, Share, Rename, Delete all show without a hover,
  // unlike the file rows in a Depot library).
  {
    id: 'browse',
    theme: 'dark',
    route: '#/home',
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openMount(id), SP_ID);
      await sleep(900);
    },
    clip: FULL,
    callouts: [
      { n: 1, selector: `.file-nav-link[data-mid="${SP_ID}"]`, place: 'r' },
      { n: 2, selector: 'button.file-library-tool[onclick="mountUploadPick()"]', place: 'l' },
      { n: 3, selector: 'button.file-library-tool[onclick="mountNewFolder()"]', place: 'r' },
      { n: 4, selector: DOWNLOAD_BTN, place: 't' },
      { n: 5, selector: SHARE_BTN, place: 't' },
    ],
    caption: 'A connected SharePoint library, with its toolbar and one file’s actions',
  },
  // The Share menu on a SharePoint file's row: view link, edit link, email people.
  {
    id: 'share-menu',
    theme: 'dark',
    route: '#/home',
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openMount(id), SP_ID);
      await sleep(900);
      await page.click(SHARE_BTN);
      await sleep(300);
      await markClipAround(page, [SHARE_BTN, '.conn-share-menu']);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: '.conn-share-menu button[data-type="view"]', place: 'l' },
      { n: 2, selector: '.conn-share-menu button[data-type="edit"]', place: 'l' },
      { n: 3, selector: '.conn-share-menu button[data-act="invite"]', place: 'l' },
    ],
    caption: 'The Share menu on a SharePoint file',
  },
  // The Unlock dialog for a personal Windows share (demo/fixtures/connections.js
  // forces SMB_CREDENTIALS_REQUIRED for this one sentinel path). Domain and Username
  // are filled with obvious placeholders; Password is left empty on purpose.
  {
    id: 'unlock',
    theme: 'dark',
    route: '#/home',
    setup: async (page) => {
      await settle(page);
      await page.eval((id, path) => openMount(id, path), SMB_ID, LOCK_SENTINEL);
      await page.waitFor('#smb-unlock-domain');
      await sleep(300);
      await page.click('#smb-unlock-domain');
      await page.type('ACME');
      await page.click('#smb-unlock-user');
      await page.type('jordan.lee');
      await sleep(200);
    },
    clip: { selector: '#smb-unlock-scrim .modal', pad: 60 },
    callouts: [
      { n: 1, selector: '#smb-unlock-domain', place: 'r' },
      { n: 2, selector: '#smb-unlock-user', place: 'r' },
      { n: 3, selector: '#smb-unlock-pass', place: 'r' },
      { n: 4, selector: '#smb-unlock-go', place: 'r' },
    ],
    caption: 'The Unlock dialog for a personal Windows share',
  },
];
