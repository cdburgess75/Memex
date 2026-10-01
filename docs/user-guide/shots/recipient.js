// Shots for "What the people you share with see" (id recipient, part 1, chapter 13, theme dark).
//   node capture/run.js recipient
//
// These four shots load the public pages an outside recipient opens directly (/s/<token>,
// /f/<token>) -- plain server-rendered pages, not the SPA -- so there is no sign-in state to
// set up. The routes they call are mocked in demo/fixtures/recipient.js, which reuses the
// same file links "My links" shows (Northfield Clinic proposal, Harbor Point Dental proposal,
// Team offsite photo) plus one extra folder link (Northfield Clinic, live, with a subfolder).
'use strict';
const { world } = require('../demo/fixtures/base');
const { NC_TOKEN } = require('../demo/fixtures/recipient');
const { F, LINKS } = world;

const tokenOf = (fileKey) => LINKS.find((l) => l.doc === F[fileKey]).token;
const TOKEN_OPEN = tokenOf('Northfield Clinic proposal');       // active, no password, can send files back
const TOKEN_LOCKED = tokenOf('Harbor Point Dental proposal');   // active, password required
const TOKEN_GONE = tokenOf('Team offsite photo');               // expired

const CARD = { selector: '.card', pad: 40 };

// The file-page card (max-width 520px) is much narrower than the folder-page card (760px),
// so a plain pad-all-sides crop of it comes out tall and narrow: aspect (height/width) over
// 1.15, which the guide's picture sizer treats as a small aside that sits beside its steps
// at a fixed, small width. That is why this picture used to print much smaller than the
// folder-page one on the next page, even though both cards hold a similar amount to read.
// Padding the sides more than the top and bottom brings the crop close to square, which the
// sizer instead prints as a big standalone picture, matching the folder-page one.
//
// The crop also stops just below the "Send files back" heading rather than at the bottom of
// the card. Callout 2 only points at that heading, and the app's own hint line right under it
// ("Drop files or a whole folder ... no account needed.") is hard-coded server side with an em
// dash, which the guide's writing rule bans. The heading's own bottom margin leaves only a few
// px of gap before that hint paragraph starts, so the crop bottom is placed halfway through
// that gap (never more than 8px past the heading) to guarantee none of the paragraph's line
// box, and so none of its text, ends up in the picture, without changing any wording in the app.
const filePageShot = {
  id: 'file-page',
  theme: 'dark',
  route: `/s/${TOKEN_OPEN}`,
  setup: async (page) => {
    await page.waitFor('#main');
    const rects = await page.eval(() => {
      const c = document.querySelector('.card').getBoundingClientRect();
      const h = document.querySelector('#up h1').getBoundingClientRect();
      const hint = document.querySelector('#up .sub').getBoundingClientRect();
      return { x: c.left, y: c.top, width: c.width, headingBottom: h.bottom, hintTop: hint.top };
    });
    const padTop = 20;
    // A few px below the heading, comfortably inside the small gap above the hint paragraph
    // so none of its line box (and so none of its em dash) is ever included.
    const padBottom = Math.max(2, Math.min(8, (rects.hintTop - rects.headingBottom) / 2));
    const height = (rects.headingBottom + padBottom) - (rects.y - padTop);
    const targetAspect = 1.05; // comfortably under the sizer's 1.15 "side" cutoff
    const padX = Math.max(padTop, (height / targetAspect - rects.width) / 2);
    filePageShot.clip = { x: rects.x - padX, y: rects.y - padTop, width: rects.width + padX * 2, height };
  },
  clip: CARD, // replaced by setup() above once the heading's real position is known
  caption: 'The page someone outside Acme sees when you share a file with them',
  callouts: [
    { n: 1, selector: '#dl', place: 'r' },
    { n: 2, selector: '#up h1', place: 'r' },
  ],
};

module.exports = [
  // The file page, unlocked: name, size, sender, Download, expiry note, and Send files back
  // (this link allows it).
  filePageShot,
  // The file page, locked: the password prompt shown before anything about the file.
  {
    id: 'file-locked',
    theme: 'dark',
    route: `/s/${TOKEN_LOCKED}`,
    setup: async (page) => { await page.waitFor('#lock'); },
    clip: CARD,
    caption: 'A file link that needs a password before it shows anything',
    callouts: [
      { n: 1, selector: '#pw', place: 'r' },
      { n: 2, selector: '#unlock', place: 'r' },
    ],
  },
  // The folder page: a subfolder inside it, a file to download on its own, Download as ZIP,
  // and Add your files (this link allows it and stays live).
  {
    id: 'folder-page',
    theme: 'dark',
    route: `/f/${NC_TOKEN}`,
    setup: async (page) => { await page.waitFor('#main'); },
    clip: { selector: '.card', pad: 44 },
    caption: 'The page someone outside Acme sees when you share a folder with them',
    callouts: [
      { n: 1, selector: '#zip', place: 'l' },
      { n: 2, selector: '#list li:nth-child(1)', place: 'l' },
      { n: 3, selector: '#list li:nth-child(2) .btn', place: 'r' },
      { n: 4, selector: '#up-h', place: 'l' },
    ],
  },
  // What a link shows once it no longer works: same "Link unavailable" page for an
  // expired link as for one that was revoked, just with a different message underneath.
  {
    id: 'link-gone',
    theme: 'dark',
    route: `/s/${TOKEN_GONE}`,
    setup: async (page) => { await page.waitFor('#gone'); },
    clip: CARD,
    caption: 'The page someone sees when a link has expired',
  },
];
