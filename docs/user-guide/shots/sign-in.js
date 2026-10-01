// Shots for the "Signing in" chapter (part 1, chapter 1).
// base.js already turns on the Microsoft 365 button (config.loginIdps includes
// 'microsoft'), so the plain sign-in card shows both providers with no extra
// fixture needed.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { sleep } = require('../capture/cdp');

module.exports = [
  // The sign-in card itself: both buttons. signedOut:true shows the login
  // screen instead of the app.
  {
    id: 'card',
    theme: 'light',
    route: '#/home',
    signedOut: true,
    caption: 'The Depot sign-in card',
    clip: { selector: '.login-modal', pad: 20 },
    callouts: [
      { n: 1, selector: '#login-ms-btn', place: 'r' },
      { n: 2, selector: '.login-providers .provider-btn:last-of-type', place: 'r' },
    ],
  },
  // What the reader sees right after signing in: Home.
  {
    id: 'home',
    theme: 'light',
    route: '#/home',
    setup: settle,
    caption: 'Home, right after signing in',
  },
  // Sign out from the user chip menu.
  {
    id: 'sign-out',
    theme: 'light',
    route: '#/home',
    setup: async (page) => {
      await settle(page);
      await page.click('#user-chip');
      await sleep(400);
    },
    clip: { x: 900, y: 0, width: 540, height: 220 },
    caption: 'Signing out from the user chip menu',
    callouts: [
      { n: 1, selector: '#user-chip', place: 'b' },
      { n: 2, selector: '#app-menu button[onclick*="signOut"]', place: 'l' },
    ],
  },
];
