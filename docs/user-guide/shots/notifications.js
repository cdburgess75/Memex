// Shots for "Getting notified about files and folders" (id notifications, part 1,
// chapter 9, theme light).
//   node capture/run.js notifications
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { F, LIB } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };
const row = (f) => `tr[data-fid="${f.id}"]`;
const folderRow = (p) => `tr[data-folder="${p}"]`;

// The file-bell shot needs a much tighter crop than the row's own bounding box: a
// table row spans nearly the full content width, so clipping to the whole row leaves
// the (small) bell icon lost in a wide, mostly-empty strip that prints tiny. Drop a
// fixed marker sized to the union of the given selectors (plus a margin) so `clip`
// can crop to just that part of the row instead. Same technique as upload.js.
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
  // 1. FILE bell: hover a file that nobody follows yet (Meeting notes — plain,
  // no other row icon already "on" to distract from the bell), so the tooltip
  // reads its off state, "Follow this file for updates" — the exact label the
  // step quotes.
  {
    id: 'file-bell',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.hover(row(F['Meeting notes']));
      await sleep(200);
      // Crop from the Size column through the action icons, dropping the wide Name
      // column: the bell is a small icon and needs the room, not the whole row.
      await markClipAround(page, [
        `${row(F['Meeting notes'])} .file-col-size`,
        `${row(F['Meeting notes'])} .file-col-actions`,
      ], 20);
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: `${row(F['Meeting notes'])} .file-bell-btn`, place: 't' },
    ],
    caption: 'Hovering a file to find its follow bell, next to its other row icons',
  },

  // 2. FOLDER bell + folder menu together: Proposals is Jordan's own folder, so
  // new-file notifications are already on (bell blue, no slash) with no clicking needed.
  // The row stays hovered while its "..." menu is open, so the bell, the menu
  // button and the plain-text toggle are all visible in one picture. Cropped
  // tight to just the row and the top of the menu (dropping the rail and most
  // of the top bar so the callout targets print large), and cut off right after
  // the notify item's own divider rule: the folder menu's lower items include
  // the broken "Move to library..." / "Copy to library..." entries, which must
  // never appear in a printed screenshot even though the steps never mention them.
  {
    id: 'folder-notifications',
    theme: 'light',
    route: '#/files',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.hover(folderRow('Proposals'));
      await page.click(`${folderRow('Proposals')} .file-library-icon-btn[title="Folder actions"]`);
      await sleep(300);
      await page.eval((rowSel, ruleSel) => {
        const row = document.querySelector(rowSel);
        const menu = document.getElementById('file-row-menu');
        const rule = document.querySelector(ruleSel);
        const rowRect = row.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const ruleRect = rule.getBoundingClientRect();
        // Extra room on the right for the "3" callout badge, which sits to the
        // right of the notify item (near the menu's own right edge).
        const left = Math.min(rowRect.left, menuRect.left) - 28;
        const top = rowRect.top - 28;
        const right = Math.max(rowRect.right, menuRect.right) + 48;
        const bottom = ruleRect.bottom + 10;
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
      }, folderRow('Proposals'), '#folder-notify-item + .file-menu-rule');
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: `${folderRow('Proposals')} .file-bell-btn`, place: 't' },
      { n: 2, selector: `${folderRow('Proposals')} .file-library-icon-btn[title="Folder actions"]`, place: 't' },
      { n: 3, selector: '#folder-notify-item', place: 'r' },
    ],
    caption: 'A folder you own already notifies you of new files, and its menu can turn that off',
  },

  // 3. The bell panel: several kinds of notice at once. Item 3 in the fixture
  // (base.js NOTIFS, newest first) is the followed-document-edited notice.
  {
    id: 'notif-panel',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.click('#notif-btn');
      await sleep(700);
      // Hide the Home page behind the open panel, so the strips beside it in the crop are
      // plain background instead of sliced-off dashboard cards.
      await page.eval(() => { document.querySelectorAll('#file-home-main, .file-home-nav').forEach((el) => { el.style.visibility = 'hidden'; }); return true; });
      // Crop from the bell in the top bar down through the third notice (the one badge 1
      // points at), not the whole tall panel: the whole panel printed as a narrow strip
      // beside the steps with its text far below reading size.
      await page.eval(() => {
        const p = document.querySelector('.notif-panel').getBoundingClientRect();
        const item = document.querySelector('.notif-list .notif-item:nth-child(3)').getBoundingClientRect();
        const bell = document.getElementById('notif-btn').getBoundingClientRect();
        const gear = document.querySelector('button[title="Settings"]').getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const left = p.left - 45, right = Math.max(p.right, gear.right) + 6, top = Math.max(0, bell.top - 14), bottom = item.bottom + 7;
        m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.width = (right - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      });
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    // Numbered to match the steps in content/notifications.json: 1 = click a notice,
    // 2 = Mark all read.
    callouts: [
      { n: 1, selector: '.notif-list .notif-item:nth-child(3)', place: 'l' },
      { n: 2, selector: '.notif-head button', place: 'l' },
    ],
    caption: 'The Notifications panel, newest first',
  },

  // 4. Settings -> Notifications: the bell on/off toggle and the "someone comes
  // online" toggle. Email is explained further down the same page (not shot;
  // its wording already says an administrator chooses it).
  {
    id: 'settings-notifications',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => openSettingsAt('notifications'));
      await sleep(500);
      // Opaque scrim (no Home bleed-through), and a crop that stops after "People coming
      // online": the email list has its own, larger picture in the next section.
      await page.eval(() => {
        for (const sc of document.querySelectorAll('.scrim.open')) { sc.style.background = 'var(--surface-2)'; sc.style.backdropFilter = 'none'; sc.style.webkitBackdropFilter = 'none'; }
        const modal = document.querySelector('.settings-modal').getBoundingClientRect();
        const online = document.getElementById('notify-online-toggle').closest('.usage-section').getBoundingClientRect();
        const m = document.createElement('div');
        m.id = 'shot-bell-settings';
        m.style.cssText = `position:fixed;pointer-events:none;left:${modal.left}px;top:${modal.top}px;width:${modal.width}px;height:${online.bottom - modal.top + 8}px`;
        document.body.appendChild(m);
      });
    },
    clip: { selector: '#shot-bell-settings', pad: 20 },
    callouts: [
      { n: 1, selector: 'label:has(#notif-pref-toggle)', place: 'r' },
      { n: 2, selector: 'label:has(#notify-online-toggle)', place: 'r' },
    ],
    caption: 'Settings, Notifications: the bell and presence alerts',
  },

  // 5. Settings -> Notifications, the "Email notifications" part: the list of notices
  // Depot emails you, as the workspace has them switched on (all four in this world).
  // The modal scrim is made opaque so the Home page cannot show through the crop.
  {
    id: 'email-notices',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => openSettingsAt('notifications'));
      await page.waitFor('.notif-email-list');
      await sleep(400);
      await page.eval(() => {
        for (const sc of document.querySelectorAll('.scrim.open')) { sc.style.background = 'var(--surface-2)'; sc.style.backdropFilter = 'none'; sc.style.webkitBackdropFilter = 'none'; }
        // Crop to the email part with room on the right for the badge, but only a little
        // above it, so none of the section before shows along the top edge.
        const r = document.querySelector('.notif-email-list').closest('.usage-section').getBoundingClientRect();
        const m = document.createElement('div');
        m.id = 'shot-email-section';
        m.style.cssText = `position:fixed;pointer-events:none;left:${r.left - 24}px;top:${r.top - 6}px;width:${r.width + 76}px;height:${r.height + 12}px`;
        document.body.appendChild(m);
      });
    },
    clip: { selector: '#shot-email-section', pad: 0 },
    callouts: [
      { n: 1, selector: '.notif-email-list', place: 'r' },
    ],
    caption: 'Settings, Notifications: the list of notices Depot emails to you',
  },
];
