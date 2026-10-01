// Shots for "Groups" (id groups, part 2, chapter 16, theme light).
//   node capture/run.js groups
// Uses base.js only (no chapter fixture needed): GROUPS already has Client services
// (Jordan owns; Jordan, Priya, Sam) and Northfield project (Jordan owns; Jordan, Sam,
// Elena and Dana Whitfield, the outside contact who has never signed in) -- exactly what
// this chapter needs to show a group with an outside member, and a library-level
// "Share to group" with no pre-existing group share to confuse the picture.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { LIB, GROUPS } = world;

const MY = { memex_library_id: LIB.jordan };

module.exports = [
  // 1. Settings -> Groups: the create-a-group form, plus the two sections underneath
  // ("Groups you manage" / "Groups you're in") so the picture also shows what "seeing
  // your groups" looks like, even though that part has no numbered steps.
  {
    id: 'groups-list',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => openSettingsAt('groups'));
      await page.waitFor('.group-create');
      await sleep(400);
      // The modal sits over the Home page, and its bottom-right corner lands right on
      // a file row (name + online dot). The scrim behind it is only a 45%-black,
      // 2px blur wash over a light page, which still reads through the padded crop
      // margin as legible text. Make the scrim fully opaque for this capture only
      // (a plain, in-theme light grey) so nothing from Home shows through the pad.
      await page.eval(() => {
        const scrim = document.getElementById('settings-scrim');
        if (scrim) {
          scrim.style.background = 'var(--surface-2)';
          scrim.style.backdropFilter = 'none';
          scrim.style.webkitBackdropFilter = 'none';
        }
      });
      // Crop to the Groups pane itself (heading, create form and the two lists), not the
      // whole Settings window with its side menu and footer: the whole window printed its
      // text at about 5pt.
      await page.eval(() => {
        const main = document.querySelector('.settings-modal .settings-main').getBoundingClientRect();
        const body = document.getElementById('groups-body').getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const left = main.left, top = main.top, right = main.right, bottom = body.bottom + 16;
        m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.width = (right - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      });
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: '#group-new-name', place: 'b' },
      { n: 2, selector: '.group-create .run-btn', place: 'b' },
    ],
    caption: 'Settings, Groups: creating a group, with the groups you manage and belong to below',
  },

  // 2. Open a group you manage: Northfield project, which already includes Dana
  // Whitfield, a client contact who has never signed in -- proof that people outside
  // Acme can belong to a group. Add field, Add button and one Remove button (on Dana's
  // row, the first row once sorted by email) are all visible without scrolling.
  // The modal is a fixed 780px-tall panel with its own scrolling body, and with 4
  // members plus the add row the manage-only actions (Rename / Change owner / Delete
  // group) only partly fit -- clipping to the whole modal sliced those buttons in half
  // right above the Close/Sign out footer. A marker sized to "top of the modal through
  // the bottom of the add row" keeps the clip to what this section actually needs.
  {
    id: 'group-open',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(async (id) => { await openSettingsAt('groups'); await openGroup(id); }, GROUPS[1].id);
      await page.waitFor('.group-members');
      await sleep(400);
      // Same as groups-list: an opaque scrim so the Home page cannot show through the crop's padding.
      await page.eval(() => { for (const sc of document.querySelectorAll('.scrim.open')) { sc.style.background = 'var(--surface-2)'; sc.style.backdropFilter = 'none'; sc.style.webkitBackdropFilter = 'none'; } });
      await page.eval(() => {
        const modal = document.querySelector('.settings-modal');
        const addEl = document.querySelector('.group-add');
        const mr = modal.getBoundingClientRect();
        const ar = addEl.getBoundingClientRect();
        let marker = document.getElementById('shot-clip-marker');
        if (!marker) {
          marker = document.createElement('div');
          marker.id = 'shot-clip-marker';
          marker.style.position = 'fixed';
          marker.style.pointerEvents = 'none';
          document.body.appendChild(marker);
        }
        marker.style.left = mr.left + 'px';
        marker.style.top = mr.top + 'px';
        marker.style.width = mr.width + 'px';
        marker.style.height = (ar.bottom - mr.top) + 'px';
      });
    },
    clip: { selector: '#shot-clip-marker', pad: 16 },
    callouts: [
      { n: 1, selector: '.group-add', place: 'l' },
      { n: 2, selector: 'button[data-email="dana@northfield-clinic.example"]', place: 'r' },
    ],
    caption: 'A group you manage: its members, and the field for adding another by email',
  },

  // 3. Share a library with a group: Client Projects has no library-level group share
  // yet (its only group share is folder-scoped, to Northfield Clinic), so the group
  // dropdown and level start clean. "Share to group" is clicked, Client services is
  // chosen, Read-Write is already the default level, and Share is ready to click.
  {
    id: 'share-to-group',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval((id) => openLibraryShare({ libraryId: id }), LIB.client);
      await page.waitFor('#ls-title');
      await sleep(400);
      await page.click('[data-ls-tab="group"]');
      await sleep(600);
      await page.eval((gid) => {
        const sel = document.querySelector('[data-ls-group]');
        sel.value = String(gid);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, GROUPS[0].id);
      await sleep(200);
      // Same as groups-list: an opaque scrim so the Home page cannot show through the crop's padding.
      await page.eval(() => { for (const sc of document.querySelectorAll('.scrim.open')) { sc.style.background = 'var(--surface-2)'; sc.style.backdropFilter = 'none'; sc.style.webkitBackdropFilter = 'none'; } });
    },
    clip: { selector: '.file-share-modal', pad: 20 },
    callouts: [
      { n: 1, selector: '[data-ls-tab="group"]', place: 'r' },
      { n: 2, selector: '[data-ls-group]', place: 'r' },
      { n: 3, selector: '[data-ls-level]', place: 'l' },
      { n: 4, selector: '[data-ls-add]', place: 'r' },
    ],
    caption: 'Sharing a library with a group instead of one person at a time',
  },
];
