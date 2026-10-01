// Shots for "Sharing a whole library" (id share-library, part 2, chapter 15, theme dark).
//   node capture/run.js share-library
// Uses base.js only: Client Projects (Jordan's, shared with Priya Read-Write and Sam
// Read-only, plus the folder "Northfield Clinic" shared with the group "Northfield
// project") gives a realistic Share tab and Who-has-access list with no extra fixture
// needed. Finance (Marcus's, shared with Jordan Read-only) stands in for a library
// Jordan does not manage, for the "Your access" shot.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { LIB, PEOPLE, U } = world;

const CLIENT = { memex_library_id: LIB.client };
const FINANCE = { memex_library_id: LIB.finance };
const PRIYA_REF = `u:${PEOPLE.priya.id}`;
const PRIYA_SHARE = U(601); // library share: Priya, Read-Write

// 1. The library switcher open on Client Projects (owned, already shared), showing the
// Share icon next to a library you own. Opening the switcher itself is taught in
// "Finding your way around", so the crop starts at the very top of the page (the whole
// top bar, uncropped, for context) and runs down through the menu. The "Rename ..." and
// "+ New library" rows are hidden before measuring, so the crop ends right after "Who
// has access to ..." -- the brief says never to feature library rename (it shows a
// false error), and this also stops the picture short of the unrelated "+ New library"
// row. Starting from the top bar instead of the heading button makes this a taller,
// still-clean picture (a whole element, not a sliver of one), so it fills more of its
// side column instead of leaving the page short next to the smaller, trimmed menu.
// Clamp x at 0: a negative clip origin makes headless Chrome's screenshot silently
// zoom-to-fit the page instead of cropping it.
const switcherOpenShot = {
  id: 'switcher-open',
  theme: 'dark',
  route: '#/files',
  localStorage: CLIENT,
  setup: async (page) => {
    await settle(page);
    await page.click('.file-library-heading');
    await sleep(300);
    await page.eval(() => {
      document.querySelectorAll('#library-menu .library-menu-item.new, #library-menu button[onclick*="renameLibrary"]')
        .forEach((el) => { el.style.display = 'none'; });
    });
    await sleep(100);
    const r = await page.eval(() => {
      const head = document.querySelector('.file-library-heading').getBoundingClientRect();
      const menu = document.getElementById('library-menu').getBoundingClientRect();
      return { left: Math.min(head.left, menu.left), right: Math.max(head.right, menu.right), bottom: menu.bottom };
    });
    const padX = 20, padBottom = 10;
    const x = Math.max(0, r.left - padX);
    switcherOpenShot.clip = { x, y: 0, width: (r.right + padX) - x, height: r.bottom + padBottom };
  },
  clip: { selector: '#library-menu', pad: 20 }, // replaced by setup() above once the trimmed menu's real size is known
  caption: 'The library switcher, with the Share icon next to an owned library',
  callouts: [
    // To the left of the Share icon, in the gap after the library name: on the right it
    // covered the pin star, a separate control (QA).
    { n: 1, selector: `.library-share-btn[data-share-lib="${LIB.client}"]`, place: 'l' },
  ],
};

module.exports = [
  switcherOpenShot,

  // 2. The Share tab: an email chip just added, Read-Write already the default level,
  // and the Share button enabled, with the existing list (owner, Priya, Sam) beneath.
  {
    id: 'share-add',
    theme: 'dark',
    route: '#/files',
    localStorage: CLIENT,
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openLibraryShare({ libraryId: id }), LIB.client);
      await page.waitFor('#ls-title');
      await page.waitFor('[data-ls-list] .ls-row');
      await page.click('[data-ls-email]');
      await page.type('elena.garcia@acme.example');
      await page.key('Enter');
      await sleep(300);
      // Crop to the dialog's title and add controls only (through the line of small print
      // under Read-Write), not the whole dialog: the full dialog printed at half the page
      // width and its small print came out far below body-text size (QA). The list of
      // people already on the library below is left out; the steps do not point at it.
      await page.eval(() => {
        const modal = document.querySelector('.file-share-modal').getBoundingClientRect();
        const add = document.querySelector('.file-share-modal .ls-add').getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const left = modal.left - 20, top = modal.top - 20, right = modal.right + 20, bottom = add.bottom + 22;
        m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.width = (right - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      });
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    caption: 'Adding someone to the Share tab, with Read-Write already chosen',
    callouts: [
      { n: 1, selector: '[data-ls-tab="user"]', place: 'l' },
      { n: 2, selector: '[data-ls-pane="user"]', place: 'r' },
      { n: 3, selector: '[data-ls-level]', place: 'r' },
      { n: 4, selector: '[data-ls-add]', place: 'r' },
    ],
  },

  // 3. The existing list underneath: Priya's row, with her level dropdown and Remove,
  // cropped tight so the row reads clearly.
  {
    id: 'share-list',
    theme: 'dark',
    route: '#/files',
    localStorage: CLIENT,
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openLibraryShare({ libraryId: id }), LIB.client);
      await page.waitFor('#ls-title');
      await page.waitFor('[data-ls-list] .ls-row');
      await sleep(300);
    },
    clip: { selector: '[data-ls-list]', pad: 30 },
    caption: 'The list of who this library is shared with, with a level dropdown and Remove',
    callouts: [
      { n: 1, selector: `.ls-row:has([data-ls-level-for="${PRIYA_SHARE}"])`, place: 't' },
      { n: 2, selector: `[data-ls-level-for="${PRIYA_SHARE}"]`, place: 't' },
      { n: 3, selector: `[data-ls-remove="${PRIYA_SHARE}"]`, place: 't' },
    ],
  },

  // 4. The Who has access tab: the filter chips, plus Priya's row expanded to show
  // Remove, Make Read-only and Resend email. Moved into one wrapper so the crop stays
  // tight (the full list also has Sam, Elena, a Waiting line and two folder links).
  {
    id: 'who-access',
    theme: 'dark',
    route: '#/files',
    localStorage: CLIENT,
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openLibraryShare({ libraryId: id, tab: 'access' }), LIB.client);
      await page.waitFor('.acc-person');
      await sleep(300);
      await page.click(`[data-acc-toggle="${PRIYA_REF}"]`);
      await sleep(300);
      // Client Projects only has 4 people on the door (this demo world has 5 accounts
      // in total), so the filter chips never appear (the app only shows them past 8).
      // The picture shows the tab and one expanded person instead.
      await page.eval((ref) => {
        const tabs = document.querySelector('.acc-tabs');
        const person = document.querySelector(`[data-acc-person="${ref}"]`);
        const wrap = document.createElement('div');
        wrap.id = 'guide-access-wrap';
        // marginBottom keeps the padded crop below from bleeding into the modal's own
        // "Share ..." heading, which sits right after this in the DOM once moved.
        // paddingBottom leaves room inside the crop for badge 2, placed under the
        // action buttons, which used to be cut in half by the bottom edge.
        wrap.style.cssText = 'display:grid;gap:14px;width:560px;margin-bottom:60px;padding-bottom:30px';
        [tabs, person].forEach((el) => { if (el) wrap.appendChild(el); });
        // Prepend (not append): the full Who-has-access list is taller than the
        // viewport, so a wrap added at the end lands scrolled out of view.
        const modal = document.querySelector('.file-share-modal');
        modal.insertBefore(wrap, modal.firstChild);
        modal.scrollTop = 0;
      }, PRIYA_REF);
      await sleep(200);
    },
    clip: { selector: '#guide-access-wrap', pad: 24 },
    caption: 'Who has access: the Who has access tab, and one person’s row expanded to show the actions',
    callouts: [
      { n: 1, selector: `[data-acc-toggle="${PRIYA_REF}"]`, place: 't' },
      { n: 2, selector: `[data-acc-person="${PRIYA_REF}"] .acc-acts`, place: 'b' },
    ],
  },

  // 5. A library Jordan does not manage (Finance, shared to him Read-only): the same
  // button reads "Your access to Finance..." and opens a read-only summary instead.
  {
    id: 'your-access',
    theme: 'dark',
    route: '#/files',
    localStorage: FINANCE,
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openLibraryAccess({ libraryId: id }), LIB.finance);
      await page.waitFor('.acc-you');
      await sleep(300);
    },
    clip: { selector: '.file-share-modal', pad: 20 },
    caption: 'Your access to a library someone else manages',
  },

  // 6. Creating a library: the New library dialog, with a name typed in.
  {
    id: 'new-library',
    theme: 'dark',
    route: '#/files',
    localStorage: CLIENT,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => openNewLibraryModal());
      await page.waitFor('#new-library-name');
      await page.click('#new-library-name');
      await page.type('Vendor contracts');
      await sleep(200);
    },
    clip: { selector: '#new-library-scrim .modal', pad: 20 },
    caption: 'Naming a new library before creating it',
    callouts: [
      { n: 1, selector: '#new-library-name', place: 'b' },
      { n: 2, selector: '#new-library-create', place: 'r' },
    ],
  },
];
