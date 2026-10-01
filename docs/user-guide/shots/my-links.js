// Shots for "Keeping track of what you've shared" (id my-links, part 1, chapter 8, theme dark).
//   node capture/run.js my-links
// Uses fixtures/my-links.js (loaded automatically: the runner sets demo_world=my-links
// for this chapter), which reorders My links's cards so the Northfield Clinic proposal
// and Harbor Point Dental proposal are first and second, and adds a Paused and a Deleted
// example so every status chip has a card. See that file for the full story.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');
const { LIB } = world;

const MY = { memex_library_id: LIB.jordan };

module.exports = [
  // The My links page: all five status chips (Active, Paused, Expired, Revoked, Deleted)
  // with real counts, and the first three cards underneath (Active + Paused is the default
  // view). Cropped just below the third card (Brand guidelines.pdf): the page keeps
  // scrolling past that in the real app, but the status chips and a couple of cards are
  // all this picture needs to show, and a shorter picture leaves the status-definition
  // bullets beside it more room on the printed page.
  {
    id: 'overview',
    theme: 'dark',
    route: '#/links',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.waitFor('.file-link-card');
      await page.eval(() => {
        const cards = document.querySelectorAll('.file-link-card');
        const cut = cards[2] || cards[cards.length - 1];
        const bottom = Math.floor(cut.getBoundingClientRect().bottom);
        const marker = document.createElement('div');
        marker.id = 'guide-links-crop';
        marker.style.cssText = `position:fixed;left:0;top:0;width:1440px;height:${bottom + 8}px;pointer-events:none`;
        document.body.appendChild(marker);
      });
    },
    clip: { selector: '#guide-links-crop', pad: 0 },
    callouts: [
      { n: 1, selector: '.file-nav-link[data-view="links"]', place: 'r' },
      { n: 2, selector: '.acc-chips', place: 'b' },
    ],
    caption: 'My links: the status chips, and the links you have made',
  },
  // Two cards moved into their own wrapper so the clip stays tight: the Northfield Clinic
  // proposal (sent to one person, can send files back) and the Harbor Point Dental
  // proposal (needs a password). No callouts: this picture illustrates the bullets beside
  // it, rather than a click to make.
  {
    id: 'card-detail',
    theme: 'dark',
    route: '#/links',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.waitFor('.file-link-card');
      await page.eval(() => {
        const list = document.getElementById('file-links-list');
        const cards = list.querySelectorAll('.file-link-card');
        const wrap = document.createElement('div');
        wrap.id = 'guide-two-cards';
        wrap.style.cssText = 'display:grid;gap:10px;margin-top:28px';
        wrap.appendChild(cards[0]);
        wrap.appendChild(cards[1]);
        list.prepend(wrap);
      });
      await sleep(200);
    },
    clip: { selector: '#guide-two-cards', pad: 20 },
    caption: 'Two link cards: who they were sent to, expiry, opens, password and send-back',
  },
  // Revoking a link: click Revoke on the card (Northfield Clinic proposal, the first
  // card), then confirm in the dialog that opens.
  {
    id: 'revoke',
    theme: 'dark',
    route: '#/links',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.waitFor('.file-link-card');
      await page.eval(() => document.querySelector('.file-link-card [data-link-id]').click());
      await page.waitFor('#ask-title');
      await sleep(300);
    },
    clip: { selector: '.modal-ask', pad: 20 },
    callouts: [
      { n: 1, selector: '#ask-ok', place: 'b' },
    ],
    caption: 'Confirming that you want to revoke a link',
  },
];
