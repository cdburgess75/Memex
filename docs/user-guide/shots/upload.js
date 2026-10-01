// Shots for "Adding files and folders" (id: upload). Uses the shared Acme world.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: world.LIB.jordan };
const FULL = { x: 0, y: 0, width: 1440, height: 900 };

// The Upload/Create dropdowns are position:absolute, so their own selector's
// bounding box does not include the open menu, and the trigger button's box
// does not include the dropdown either. Drop a fixed marker sized to the union
// of a list of selectors (plus an optional extra margin) so `clip` can crop to
// exactly "button + open menu" instead of the whole viewport.
async function markClipAround(page, selectors, pad = 44) {
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

const UPLOAD_BTN = '#file-library-commandbar .masthead-upload-secondary';
const CREATE_BTN = '#file-library-commandbar .masthead-upload:not(.masthead-upload-secondary)';
const FILTER_WRAP = '.file-filter-wrap';

module.exports = [
  {
    id: 'upload-menu',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(UPLOAD_BTN);
      await sleep(300);
      // Include the Create button and the type filter too: the Upload button sits only
      // 8px from Create and ~21px from the filter, so padding the Upload button alone
      // sliced through their labels instead of leaving clean whitespace. Widening the
      // marked region to fully cover both neighbors keeps their whole labels in frame.
      await markClipAround(page, [CREATE_BTN, UPLOAD_BTN, '#file-upload-menu', FILTER_WRAP]);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: UPLOAD_BTN, place: 't' },
      { n: 2, selector: '#file-upload-menu button[onclick*="chooseUpload(\'files\')"]', place: 'r' },
      { n: 3, selector: '#file-upload-menu button[onclick*="chooseUpload(\'folder\')"]', place: 'r' },
    ],
    caption: 'The Upload menu, open above the file list',
  },
  {
    id: 'create-menu',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(CREATE_BTN);
      await sleep(300);
      await markClipAround(page, [CREATE_BTN, '#file-create-menu']);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: CREATE_BTN, place: 't' },
      { n: 2, selector: '#file-create-menu button[onclick*="createFolder"]', place: 'r' },
      { n: 3, selector: '#file-create-menu button[onclick*="createFile(\'docx\')"]', place: 'r' },
      { n: 4, selector: '#file-create-menu button[onclick*="createFile(\'xlsx\')"]', place: 'r' },
    ],
    caption: 'The Create menu, open above the file list',
  },
  {
    id: 'drag-drop',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => document.getElementById('file-home-shell')?.classList.add('dragging'));
      await sleep(200);
    },
    clip: FULL,
    callouts: [{ n: 1, selector: '#file-list', place: 't', box: false }],
    caption: 'The Files page highlighted while dragging files in from the desktop',
  },
];
