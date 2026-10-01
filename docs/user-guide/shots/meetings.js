// Shots for "Meetings and calls" (id meetings, part 2, chapter 14, theme light).
//   node capture/run.js meetings
//
// Presence comes from the demo's own WebSocket (base.js exports.presence: Priya Shah and
// Marcus Chen are online). getUserMedia (camera/mic) hangs forever in this headless Chrome
// even with --use-fake-device-for-media-stream — macOS still gates it behind a system
// permission prompt that headless Chrome can never answer. So the in-call shot never calls
// startRoom()/ensureMedia(): it sets callRoom and a fake peer directly and calls
// renderCallDock(), which needs no camera and renders the exact same dock and controls a
// real call would. The self tile is simply absent (no localStream), which is fine: the
// picture's job is the control bar, not a face.
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { LIB } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };

// Presence arrives over the WebSocket a little after settle() returns. Give it a moment,
// with a real wait loop rather than a guess, before reading or opening anything that shows
// who is online.
const waitOnline = (page) => page.eval(async () => {
  const until = Date.now() + 4000;
  while (Date.now() < until && !(typeof callOnline !== 'undefined' && callOnline.length)) {
    await new Promise((r) => setTimeout(r, 100));
  }
});

// The dock floats over the Home page rather than covering it, so a uniform pad around
// '.call-dock' reveals slivers of whatever Home card sits just above or below it (here, the
// Notifications list above and a shared-link row below, both nearly flush with the dock's own
// edges). Pad the sides for breathing room but crop flush with the dock's own top and bottom,
// which is what a real viewer sees: the dock's own background right up to that line, hiding
// the page behind it. setup fills in the exact box (computed from the live layout) before the
// clip is read.
const inCallClip = { x: 0, y: 0, width: 0, height: 0 };
const inCallControls = {
  id: 'in-call-controls',
  theme: 'light',
  route: '#/home',
  localStorage: MY,
  setup: async (page) => {
    await settle(page);
    await page.eval(() => {
      callRoom = 'room-demo';
      callPeers.set('p1', { pc: null, name: 'Priya Shah', stream: null });
      renderCallDock();
      // A peer with no stream renders the app's own "connecting…" placeholder, which is
      // correct while a real call is dialing but reads as a stalled screen in a still picture.
      // Headless Chrome can never grant a fake camera (see file header), so stand in with a
      // simple fake video tile: the same colored-initials avatar the app already uses for a
      // person elsewhere (Home's "online" faces, via libTone/initials), centered over the tile
      // in place of the "connecting…" text. This reads as an active call with the camera off,
      // not a call that never finished loading.
      const wait = document.querySelector('.call-tile[data-tile="p1"] .call-tile-wait');
      if (wait) {
        const tone = libTone('Priya Shah');
        wait.innerHTML = `<span style="width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:700 22px var(--ui, sans-serif);color:#fff;background:${tone};">PS</span>`;
      }
    });
    await sleep(300);
    const dock = await page.eval(() => {
      const r = document.querySelector('.call-dock').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    inCallClip.x = dock.left - 16;
    inCallClip.y = dock.top;
    inCallClip.width = (dock.right - dock.left) + 32;
    inCallClip.height = dock.bottom - dock.top;
  },
  clip: inCallClip,
  callouts: [
    { n: 1, selector: '[aria-label="Microphone"]', place: 't' },
    { n: 2, selector: '[aria-label="Camera"]', place: 't' },
    { n: 3, selector: '[aria-label="Share screen"]', place: 't' },
    { n: 4, selector: '[aria-label="Send a file"]', place: 't' },
    { n: 5, selector: '[aria-label="Leave call"]', place: 't' },
  ],
  caption: 'The controls once you are in a call',
};

module.exports = [
  // 1. The Meetings icon (with its green "someone is online" dot) and the open panel:
  // People online, Start a meeting, Schedule a meeting. A manual clip, not a selector clip:
  // the panel is position:absolute so its own box does not include the button above it, and
  // no single element bounds both. Sized and padded from the two real boxes (button
  // 1101,10,36,36 and panel 877,54,260,259) so every callout badge lands inside the crop.
  {
    id: 'meet-panel',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await waitOnline(page);
      await page.click('#meet-btn');
      await sleep(400);
      // Type a short real room name so the picture shows complete text: the field is
      // narrower than the full placeholder ("Room name (e.g. standup)"), which otherwise
      // shows as truncated, unclosed example text with no real value behind it.
      await page.eval(() => { document.getElementById('meet-room-input').value = 'standup'; });
    },
    clip: { x: 845, y: 0, width: 320, height: 350 },
    callouts: [
      // Placed at the button's top-left corner rather than fully to its left: the Meetings
      // icon sits only a few pixels from the Status pill, so a badge centered to its left (or
      // straight above, clamped down by the viewport edge) lands on top of that pill's text or
      // the icon itself. The corner position clears both, just brushing the pill's own end
      // padding.
      { n: 1, selector: '#meet-btn', place: 'tl' },
      { n: 2, selector: '.meet-person:nth-of-type(1)', place: 'l' },
      { n: 3, selector: '#meet-room-input', place: 'l' },
      { n: 4, selector: '.meet-room .run-btn', place: 'r' },
      { n: 5, selector: '.meet-panel .ghost-btn', place: 'b' },
    ],
    caption: 'The Meetings panel: who is online, starting a call, and scheduling one',
  },

  // 2. Schedule a meeting, filled in: a title, the date/time/length row (left at their
  // sensible defaults), attendees (one colleague, one person outside Acme, to make the
  // "needs a Depot account" note concrete), a note, and the two send buttons.
  {
    id: 'schedule-meeting',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => openScheduleMeeting());
      await sleep(200);
      await page.eval(() => { document.getElementById('mt-title').value = 'Northfield Clinic kickoff call'; });
      await page.eval(() => { document.getElementById('mt-attendees').value = 'sam.okafor@acme.example, dana@northfield-clinic.example'; });
      await page.eval(() => { document.getElementById('mt-note').value = 'Review the proposal before we call.'; });
      await sleep(200);
    },
    clip: { selector: '#schedule-scrim .modal', pad: 20 },
    callouts: [
      { n: 1, selector: '#mt-title', place: 'r' },
      { n: 2, selector: '#schedule-scrim div[style*="flex-wrap"]', place: 'l' },
      { n: 3, selector: '#mt-attendees', place: 'r' },
      { n: 4, selector: '#mt-note', place: 'r' },
      { n: 5, selector: '#schedule-scrim .btn-row', place: 't' },
    ],
    caption: 'Scheduling a meeting: title, date and time, attendees, a note, and how to send it',
  },

  // 3. Someone calling you: the incoming-call card with Accept and Decline. Faked directly
  // (setting incomingCall and calling renderIncomingCall) since a real incoming call needs a
  // second signed-in browser to ring this one.
  {
    id: 'incoming-call',
    theme: 'light',
    route: '#/home',
    localStorage: MY,
    setup: async (page) => {
      await settle(page);
      await page.eval(() => {
        incomingCall = { from: { userId: 'demo-caller', name: 'Priya Shah' }, room: 'dm-demo' };
        renderIncomingCall();
      });
      await sleep(200);
    },
    clip: { selector: '.call-incoming', pad: 24 },
    callouts: [
      { n: 1, selector: '.call-accept', place: 'b' },
      { n: 2, selector: '.call-decline', place: 'b' },
    ],
    caption: 'A call arriving: accept it or decline it',
  },

  // 4. The in-call control bar: Mute, camera, Share screen, Send a file, Leave call. See the
  // file header for why this does not go through startRoom()/ensureMedia(). A fake peer
  // (Priya Shah, no stream yet) fills the tile with a realistic "connecting..." rather than
  // leaving the call body empty.
  inCallControls,
];
