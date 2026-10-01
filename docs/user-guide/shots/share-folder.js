// Shots for "Sharing a folder" (part 1, chapter 7, theme light).
// All three shots use the same folder, Client Projects / Northfield Clinic / Site photos,
// which Jordan owns (so the Share window's People and groups tools are open to him) and
// which already has one active "anyone with the link" folder link in the fixture world
// (base.js FOLDER_LINKS, id U(351)) -- handy for the "revoke a link" callout with no extra
// fixture needed.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { LIB } = world;

const CLIENT = { memex_library_id: LIB.client };
const PATH = 'Northfield Clinic/Site photos';
const ROW = `tr[data-folder="${PATH}"]`;
// The file Share dialog (shots/share-file.js) clips to the whole card so the picture is
// a tight floating dialog with no page chrome behind it; the folder Share dialog is the
// same element, so it gets the same treatment.
const MODAL = { selector: '.file-share-modal', pad: 20 };

// Open the folder's Share window and wait for it to finish loading (it fetches the
// existing folder links as soon as it opens).
async function openDialog(page) {
  await settle(page);
  await page.eval((p) => openFolderShare(p), PATH);
  await page.waitFor('#fs-title');
  await sleep(700);
}
async function showSection(page, n) {
  await page.eval((i) => {
    document.querySelectorAll('.file-share-modal .file-share-section')[i]?.scrollIntoView({ block: 'start' });
  }, n);
  await sleep(250);
}
// Rows sit flush against each other with no gap, so a plain symmetric pad around one row
// either stops mid way through the next row (a bare pad big enough to reach the column
// header above also reaches partway into the row below) or misses the header entirely.
// Drop a fixed marker sized to "header context above" + "the full next row below" instead,
// the same clip-marker technique as shots/organise.js and shots/upload.js, so the crop
// never slices a row in half.
async function markRowClip(page, rowSel, { topPad = 28, sidePad = 28, bottomPad = 0 } = {}) {
  await page.eval((rowSel, topPad, sidePad, bottomPad) => {
    const row = document.querySelector(rowSel);
    if (!row) return;
    const next = row.nextElementSibling;
    const r = row.getBoundingClientRect();
    const n = next ? next.getBoundingClientRect() : null;
    const left = r.left - sidePad, top = r.top - topPad, right = r.right + sidePad;
    const bottom = (n ? n.bottom : r.bottom) + bottomPad;
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
  }, rowSel, topPad, sidePad, bottomPad);
}

module.exports = [
  // Where the Share icon lives on a folder row (hover only shows it; a screenshot with no
  // clip drops :hover in headless Chrome, so this clips around the row itself rather than
  // the whole viewport, which keeps the row and its icon large enough to read when printed;
  // the marker includes the column header above for context and the full next row below so
  // neither is left half-visible).
  {
    id: 'open',
    theme: 'light',
    route: '#/files/Northfield%20Clinic',
    localStorage: CLIENT,
    setup: async (page) => { await settle(page); await page.hover(ROW); await markRowClip(page, ROW); },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'Pointing to a folder row to reveal its Share icon',
    callouts: [
      { n: 1, selector: `${ROW} .file-library-icon-btn[title="Share"]`, place: 't' },
    ],
  },
  // The "Send to people" section, filled in: an email chip, expiry, password, a note and
  // the "let them add files back" toggle turned on.
  {
    id: 'send-to-people',
    theme: 'light',
    route: '#/files/Northfield%20Clinic',
    localStorage: CLIENT,
    setup: async (page) => {
      await openDialog(page);
      await showSection(page, 1);
      await page.click('#fsend-input');
      await page.type('dana@northfield-clinic.example');
      await page.key('Enter');
      await page.eval(() => { const el = document.getElementById('fsend-expiry'); el.value = '30'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.click('#fsend-password');
      await page.type('Walkthrough2026');
      await page.click('#fsend-note');
      await page.type('Here are the site photos for Thursday’s walkthrough.');
      await page.click('#fsend-upload');
      await showSection(page, 1);
      // Crop to this one section, not the whole dialog: the whole dialog printed its small
      // print at about 4pt, and its lower half repeated the "Anyone with the link" section
      // pictured just before. The sides keep 50px for the badges.
      await page.eval(() => {
        const r = document.querySelectorAll('.file-share-modal .file-share-section')[1].getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const top = Math.max(0, r.top - 18), bottom = r.bottom + 16, left = Math.max(0, r.left - 50);
        m.style.left = left + 'px'; m.style.top = top + 'px';
        m.style.width = (r.right + 50 - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      });
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'The Send to people section, filled in',
    callouts: [
      { n: 1, selector: '#fsend-chips', place: 'r' },
      { n: 2, selector: '#fsend-expiry', place: 'r' },
      { n: 3, selector: '#fsend-password', place: 'r' },
      { n: 4, selector: 'label.share-toggle', place: 'l' },
      { n: 5, selector: '#fsend-go', place: 'l' },
    ],
  },
  // The "Anyone with the link" section: the create-link form, plus the one active link
  // already in the fixture world, with its Revoke button.
  {
    id: 'anyone-link',
    theme: 'light',
    route: '#/files/Northfield%20Clinic',
    localStorage: CLIENT,
    setup: async (page) => {
      await openDialog(page);
      await showSection(page, 2);
      // Asymmetric marker, not a symmetric pad: 50px above the section reached up into
      // the "Send to people" section and caught half of its Send button (QA). The sides
      // keep 50px for the badges placed to the right of each control.
      await page.eval(() => {
        const r = document.querySelector('.file-share-modal .file-share-section:nth-of-type(3)').getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const top = r.top - 18, bottom = r.bottom + 16, left = Math.max(0, r.left - 50);
        m.style.left = left + 'px'; m.style.top = top + 'px';
        m.style.width = (r.right + 50 - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      });
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'The Anyone with the link section, with one link already active',
    // Only 3 callouts: they match the 3 numbered steps in the "Create a link anyone
    // can open" section (Expires, Password, Create link). The existing active link's
    // Revoke button stays visible in the crop for context, but is not numbered here
    // since Revoke is not one of that section's steps (it is covered separately by
    // the note in "Send it to named people").
    callouts: [
      { n: 1, selector: '#folder-share-expiry', place: 'r' },
      { n: 2, selector: '#folder-share-password', place: 'r' },
      { n: 3, selector: '.file-share-section:nth-of-type(3) .run-btn', place: 'r' },
    ],
  },
];
