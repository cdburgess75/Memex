// Shots for content/light-dark.json — "Light or dark: making Depot comfortable"
// (part 1, chapter 12, theme both). This is the one chapter that shows the SAME
// screen in both light and dark, so readers recognise each look; the other
// shots use whichever theme reads best for that particular dialog.
//   node capture/run.js light-dark
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: world.LIB.jordan };

// Unions the boxes of several selectors into one fixed marker element, so a shot
// can crop around a group of controls that share no common wrapper (the settings
// panel writes its sections as sibling <div>s, not a container per section). Pad
// is asymmetric because the callouts here sit to the right of their targets, so
// the crop needs more room on that side than above or below (which would
// otherwise bleed into the settings title or the next section's heading).
async function markRectFixed(page, selectors, pad = {}) {
  const { top = 14, right = 14, bottom = 14, left = 14 } = pad;
  await page.eval((sels, p) => {
    document.getElementById('__clipmark')?.remove();
    const rects = sels.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter((r) => r && r.width && r.height);
    if (!rects.length) return;
    let l = Math.min(...rects.map((r) => r.left)) - p.left;
    let t = Math.min(...rects.map((r) => r.top)) - p.top;
    let rr = Math.max(...rects.map((r) => r.right)) + p.right;
    let b = Math.max(...rects.map((r) => r.bottom)) + p.bottom;
    // The settings body's rows (.profile-row, .scheme-cards) are unstyled flex/grid
    // blocks that stretch to the full width of the panel even though their visible
    // content is narrower, so a right-side pad added for a callout badge can push
    // past the modal's own edge and into the dimmed page behind it. Clamp to the
    // open settings modal's box so the crop never bleeds past its border.
    const modal = document.querySelector('.settings-modal');
    if (modal) {
      const mb = modal.getBoundingClientRect();
      l = Math.max(l, mb.left + 1);
      t = Math.max(t, mb.top + 1);
      rr = Math.min(rr, mb.right - 1);
      b = Math.min(b, mb.bottom - 1);
    }
    const mark = document.createElement('div');
    mark.id = '__clipmark';
    mark.style.cssText = `position:fixed;left:${l}px;top:${t}px;width:${rr - l}px;height:${b - t}px;pointer-events:none`;
    document.body.appendChild(mark);
  }, selectors, { top, right, bottom, left });
}

const openAppearance = async (page) => {
  await settle(page);
  await page.eval(() => openSettings());
  await sleep(500);
};

module.exports = [
  // 1. The quick way: the sun/moon icon at the right of the top bar. Captured in
  // light mode, so this one small picture also does double duty as the chapter's
  // only non-Settings shot and its only picture of the app in Light mode (the
  // chapter theme is "both", but the Settings shots below are both dark).
  // Cropped tight to the icon cluster. The bottom pad is much bigger than the
  // others: the callout badge sits below the button at +40px, and `.mast-icon-btn`
  // is only 36px tall and centered in the row with almost no headroom of its own,
  // so a symmetric pad would either clip the badge or waste space on all four
  // sides just to fit it on one. A small side/top pad keeps the picture tight.
  {
    id: 'theme-toggle',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    // Not markRectFixed: its modal-clamp queries `.settings-modal` unconditionally,
    // and that element sits in the DOM (closed, zero-sized) even on Home, which
    // clamped this crop to nothing. This route never has a modal open, so a plain
    // asymmetric-pad marker is enough.
    setup: async (page) => {
      await settle(page);
      await page.eval((pad) => {
        document.getElementById('__clipmark')?.remove();
        const r = document.querySelector('.masthead-actions').getBoundingClientRect();
        const mark = document.createElement('div');
        mark.id = '__clipmark';
        mark.style.cssText = `position:fixed;left:${r.left - pad.left}px;top:${r.top - pad.top}px;width:${r.width + pad.left + pad.right}px;height:${r.height + pad.top + pad.bottom}px;pointer-events:none`;
        document.body.appendChild(mark);
      }, { top: 14, right: 14, bottom: 46, left: 14 });
    },
    clip: { selector: '#__clipmark', pad: 0 },
    callouts: [{ n: 1, selector: '#theme-btn', place: 'b' }],
    // In light mode the button itself shows a moon (the app swaps in a sun once
    // dark mode is on, so the icon always previews the mode a click leads to).
    caption: 'The moon icon at the right of the top bar, Depot in its light look',
  },

  // 2. Settings -> Profile & appearance, top half: photo and name. Opens on this
  // tab by default, so no click is needed to get here beyond the gear icon.
  {
    id: 'profile',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await openAppearance(page);
      await markRectFixed(page, ['.profile-row', 'button[onclick="saveProfile()"]'], { top: 10, right: 46, bottom: 10, left: 14 });
    },
    clip: { selector: '#__clipmark', pad: 0 },
    callouts: [
      { n: 1, selector: 'button[onclick="document.getElementById(\'profile-avatar-input\').click()"]', place: 'r' },
      { n: 2, selector: '#profile-name', place: 't' },
      { n: 3, selector: 'button[onclick="saveProfile()"]', place: 'r' },
    ],
    caption: 'Settings, Profile & appearance: your photo and name',
  },

  // 3. Settings -> Profile & appearance, bottom half: Mode and Scheme. The device
  // is given its own scheme (Harbor) so the "Use the workspace scheme" button
  // actually shows, and the panel is scrolled so Mode lands at the top (the
  // profile fields above would otherwise push Scheme below the fold).
  {
    id: 'appearance',
    theme: 'dark',
    route: '#/home',
    localStorage: Object.assign({ memex_scheme: 'harbor' }, MY),
    setup: async (page) => {
      await openAppearance(page);
      await page.eval(() => {
        const body = document.getElementById('settings-body');
        const heading = body.querySelector('.settings-sub');
        if (heading) body.scrollTop = Math.max(0, heading.offsetTop - 4);
      });
      await sleep(150);
      await markRectFixed(page, ['.settings-sub', '.scheme-cards', 'button[onclick="pickDeviceScheme(\'\')"]'], { top: 10, right: 46, bottom: 10, left: 14 });
    },
    clip: { selector: '#__clipmark', pad: 0 },
    callouts: [
      { n: 1, selector: '.share-seg[aria-label="Mode"]', place: 'r' },
      { n: 2, selector: '.scheme-card.active', place: 'tr' },
      { n: 3, selector: 'button[onclick="pickDeviceScheme(\'\')"]', place: 'r' },
    ],
    caption: 'Settings, Profile & appearance: Mode and Scheme, with a device scheme already picked',
  },
];
