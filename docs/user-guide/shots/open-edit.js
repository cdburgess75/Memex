// Shots for "Opening, previewing and editing" (id open-edit, part 1, chapter 4, theme dark).
//   node capture/run.js open-edit
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { F, LIB } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };
const MODAL = { selector: '.file-preview-modal', pad: 20 };
// openModal() focuses the first button in the header, which draws a default browser
// focus ring that has nothing to do with our callouts. Blur it before every screenshot.
const unfocus = (page) => page.eval(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
const preview = (id, ms = 1800) => async (page) => { await settle(page); await page.eval((fid) => previewFile(fid), id); await sleep(ms); await unfocus(page); };

module.exports = [
  // 1. What a preview looks like: a PDF, full page, no callouts (just an illustration).
  {
    id: 'preview-pdf',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    setup: preview(F['Harbor Point Dental proposal'].id, 2500),
    clip: MODAL,
    caption: 'Previewing a PDF without downloading it',
  },
  // 2. The action bar. Details stays closed here (its own picture would collide with
  // the callout below the Details button); its contents are described in the text instead.
  {
    id: 'action-bar',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    setup: preview(F['Northfield Clinic proposal'].id, 1800),
    // Tighter than MODAL on purpose: the full modal also shows the document body
    // (Summary paragraph, bullet list, Timeline table) in small print that none of the
    // steps refer to. The modal is centered at 940x774 in the 1440x900 viewport (so
    // x=(1440-940)/2=250, y=(900-774)/2=63); this clip keeps the header, the 5 callout
    // badges and just the title and "Prepared for" line of the document, and cuts off
    // before the Summary heading so no unreferenced body text is prominent on the page.
    clip: { x: 230, y: 43, width: 980, height: 230 },
    callouts: [
      { n: 1, selector: '.file-preview-head-actions .run-btn', place: 'b' },
      { n: 2, selector: '.file-preview-head-actions button[onclick="togglePreviewOpenMenu(event)"]', place: 'b' },
      { n: 3, selector: '.file-preview-head-actions button[onclick*="openShareFile"]', place: 'b' },
      { n: 4, selector: '.file-preview-head-actions button[onclick*="downloadFile"]', place: 'b' },
      { n: 5, selector: '.file-preview-head-actions button[onclick="togglePreviewInfo()"]', place: 'b' },
    ],
    caption: 'The action bar above a preview, cropped just below the document title',
  },
  // 3. The "Open in" menu for an Office file: edit in browser, or hand off to desktop Office.
  {
    id: 'open-in-menu',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    setup: async (page) => {
      await preview(F['Northfield Clinic proposal'].id, 1800)(page);
      await page.click('button[onclick="togglePreviewOpenMenu(event)"]');
      await sleep(400);
      await unfocus(page);
    },
    clip: MODAL,
    callouts: [
      { n: 1, selector: '#preview-open-menu button[onclick*="editInBrowser"]', place: 'l' },
      { n: 2, selector: '#preview-open-menu button[onclick*="openInDesktopOffice"]', place: 'l' },
    ],
    caption: 'Choosing how to open a Word, Excel or PowerPoint file',
  },
];
