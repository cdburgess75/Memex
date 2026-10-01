// Shots for "Keeping things organised" (organise.json).
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { F, LIB } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };
const row = (f) => `tr[data-fid="${f.id}"]`;
const FULL = { x: 0, y: 0, width: 1440, height: 900 };

// Dropdown menus and row menus are position:absolute/fixed, so their own
// selector's box (or the trigger button's box) does not include the open
// menu. Drop a fixed marker sized to the union of a list of selectors (plus
// a margin) so `clip` can crop to exactly "button + open menu" instead of
// the whole viewport, keeping printed text legible. Matches the pattern in
// shots/upload.js and shots/connections.js.
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
const CREATE_BTN = '#file-library-commandbar .masthead-upload:not(.masthead-upload-secondary)';
const FILTER_BTN = '#file-filter-btn';

// Jordan's own library root: Meeting notes.md, Q3 budget.xlsx, Q3 review.pptx,
// Expenses September.csv, Travel itinerary.pdf, plus folders Proposals, Contracts,
// Photos, Reports. Files and folders live in the same list, which is what lets one
// screenshot show both a file row and a folder row together.

module.exports = [
  // 1. New folder: the Create menu open, before the "New folder" click.
  {
    id: 'create-menu', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(CREATE_BTN);
      await sleep(300);
      await markClipAround(page, [CREATE_BTN, '#file-create-menu']);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'The Create menu open, showing New folder',
    callouts: [
      { n: 1, selector: CREATE_BTN, place: 't' },
      { n: 2, selector: '#file-create-menu button:first-child', place: 'r' },
    ],
  },

  // 2. Rename: a file row's Actions menu open, showing "Rename...". Uses the top
  //    row of Proposals/2026 (files only, no subfolders) so the menu opens cleanly
  //    below it instead of being clamped up the screen.
  {
    id: 'rename-menu', theme: 'light', route: '#/files/Proposals/2026', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      const actions = `${row(F['Harbor Point Dental proposal'])} .file-library-icon-btn[title="Actions"]`;
      await page.hover(row(F['Harbor Point Dental proposal']));
      await page.click(actions);
      await sleep(300);
      // #file-row-menu is appended straight to <body> (position: fixed), so it
      // never sits inside the row's own box: mark the union instead of relying
      // on a container selector.
      await markClipAround(page, [actions, '#file-row-menu']);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'A file row menu open, showing Rename',
    callouts: [
      { n: 1, selector: `${row(F['Harbor Point Dental proposal'])} .file-library-icon-btn[title="Actions"]`, place: 't' },
      { n: 2, selector: '#file-row-menu .file-menu-item[onclick*="renameFile"]', place: 'r' },
    ],
  },

  // 3. Move to folder: the folder picker, opened straight from moveFileToFolder.
  {
    id: 'move-picker', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => moveFileToFolder(id), F['Travel itinerary'].id);
      await sleep(500);
    },
    clip: { selector: '#folder-picker-scrim .modal', pad: 20 },
    caption: 'Choosing a destination folder',
    callouts: [
      { n: 1, selector: '#folder-picker-scrim button[data-path="Photos"]', place: 'r' },
    ],
  },

  // 4. Move to another library: the library transfer dialog, two files selected.
  {
    id: 'move-library', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(`${row(F['Meeting notes'])} .file-library-select`);
      await page.click(`${row(F['Q3 budget'])} .file-library-select`);
      await sleep(200);
      await page.eval(() => openLibraryTransfer('move'));
      await sleep(400);
    },
    clip: { selector: '#library-transfer-scrim .modal', pad: 20 },
    caption: 'Moving files to another library',
    callouts: [
      { n: 1, selector: '#library-transfer-scrim button[data-lib]', place: 'r' },
    ],
  },

  // 5. Select several items: checkboxes + the selection bar (Move to folder, Move
  //    to library, Delete).
  {
    id: 'selection-bar', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(`${row(F['Meeting notes'])} .file-library-select`);
      await page.click(`${row(F['Q3 budget'])} .file-library-select`);
      await sleep(300);
    },
    clip: { selector: '#file-library-view', pad: 40 },
    caption: 'Two files selected, with the selection bar above the list',
    callouts: [
      { n: 1, selector: `${row(F['Meeting notes'])} .file-library-select`, place: 'l' },
      { n: 2, selector: '.file-library-tool[onclick="moveSelectedToFolder()"]', place: 'b' },
      { n: 3, selector: '.file-library-tool[onclick="openLibraryTransfer(\'move\')"]', place: 'b' },
      { n: 4, selector: '.file-library-tool[onclick="deleteSelectedItems()"]', place: 'b' },
    ],
  },

  // 6. Filter, sort and change the view: the "All types" filter menu open.
  {
    id: 'filter-type', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(FILTER_BTN);
      await sleep(300);
      await markClipAround(page, [FILTER_BTN, '#file-filter-menu']);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'The All types filter menu open',
    callouts: [
      { n: 1, selector: FILTER_BTN, place: 't' },
      { n: 2, selector: '.file-filter-item[onclick="setFileFilter(\'images\')"]', place: 'r' },
    ],
  },

  // 7. Sort: click the Size column heading, showing the sort arrow, with all
  //    three sortable headings marked.
  {
    id: 'sort-columns', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click('.file-col-size .file-col-sort');
      await sleep(300);
    },
    clip: { selector: '#file-library-view', pad: 16 },
    caption: 'The file list sorted by Size',
    callouts: [
      { n: 1, selector: '.file-col-name .file-col-sort', place: 't' },
      { n: 1, selector: '.file-col-size .file-col-sort', place: 't' },
      { n: 1, selector: '.file-col-modified .file-col-sort', place: 't' },
    ],
  },

  // 8. View-size slider: tiles view, with the slider marked.
  {
    id: 'view-slider', theme: 'light', route: '#/files', localStorage: { ...MY, memex_file_view_size: '3' },
    setup: settle,
    clip: { selector: '#file-library-view', pad: 16 },
    caption: 'Files shown as tiles, with the view slider at the top right',
    callouts: [
      { n: 1, selector: '.file-view-slider', place: 'b' },
    ],
  },

  // 9. Delete and Undo: two files deleted, the Undo toast showing.
  {
    id: 'delete-undo', theme: 'light', route: '#/files', localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click(`${row(F['Meeting notes'])} .file-library-select`);
      await page.click(`${row(F['Q3 budget'])} .file-library-select`);
      await sleep(200);
      await page.eval(() => deleteSelectedItems());
      await sleep(900);
    },
    clip: { selector: '#toast', pad: 30 },
    caption: 'The Undo toast after deleting two files',
    callouts: [
      { n: 1, selector: '.toast-action', place: 'r' },
    ],
  },

  // 10. Restore from Trash: the Trash page, hovering a row to reveal Restore.
  {
    id: 'trash-restore', theme: 'light', route: '#/trash',
    setup: async (page) => {
      await settle(page);
      await page.hover('#file-list tbody tr');
    },
    clip: FULL,
    caption: 'The Trash page, with Restore on a row',
    callouts: [
      { n: 1, selector: '.file-nav-link[data-view="trash"]', place: 'r' },
      { n: 2, selector: '#file-list tbody tr .file-action-btn.primary', place: 't' },
    ],
  },
];
