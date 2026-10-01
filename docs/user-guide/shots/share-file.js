// Shots for "Sharing a file" (id share-file, part 1, chapter 6, theme dark).
//   node capture/run.js share-file
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { F, LIB } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };
const FILE_ID = F['Northfield Clinic proposal'].id;
// The file's own Share dialog: it has an existing link to Dana Whitfield (My links / world-notes),
// which gives "Who has access" and "Revoke" real data to show instead of an empty list.
// QA: 'share-lock' used to type a hypothetical 2026-10-29 into the expiry field, which never
// matched this existing link's real expiry date shown two shots later in 'share-access'
// (base.js line 150: expires ahead(27 days)). Read that same link's expiry back out of the
// fixture instead of hardcoding a date, so the two stay in sync no matter what day this runs.
// The app displays expiry with shareDate() (new Date(iso).toLocaleString(), local time), so the
// input value below is also built from the LOCAL calendar date, not the ISO string's UTC date:
// near a day boundary those two can name different days for the same instant.
const DANA_LINK = world.LINKS.find((l) => l.id === world.U(301));
const DANA_EXPIRY_ISO = DANA_LINK.expires;
const MODAL = { selector: '.file-share-modal', pad: 20 };
// Tighter crops for the two shots whose QA flagged the modal-wide clip: cropping to just the
// element the steps point to (instead of the whole 760px-wide dialog, plus its own secondary
// fine print and numbered headers) keeps the remaining text large enough to read when printed,
// and stops the dialog's own step numbers from sitting beside the guide's orange callout numbers.
const FLOW = { selector: '.share-flow', pad: 50 };
const ACCESS = { selector: '#file-access-details', pad: 50 };
const openDialog = async (page) => {
  await settle(page);
  await page.eval((id) => openShareFile(id), FILE_ID);
  await sleep(1200); // access list + existing-links list both load over the network
};

module.exports = [
  // 1. Step 1 (Who gets it) and step 2 (What they can do): invite mode, two people added,
  // one colleague and one person outside Acme, so both kinds of chip are visible at once.
  {
    id: 'share-people',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    setup: async (page) => {
      await openDialog(page);
      await page.eval(() => shareSetWho('people'));
      // Typing + Enter per address is awkward to sequence reliably; the chip list is a
      // plain top-level array the app already exposes a render function for.
      await page.eval((emails) => { for (const e of emails) _shareEmails.push(e); renderShareChips(); },
        ['marcus.chen@acme.example', 'dana@northfield-clinic.example']);
      // Trim to just the two steps this picture illustrates: hide "How long and how locked"
      // (it gets its own picture next), the colleague/password fine print (already said in
      // the guide's own text, in "What the people you invite receive"), and the dialog's own
      // small step-number circles, which sit right beside the guide's orange callout numbers
      // and are easy to mistake for them.
      await page.eval(() => {
        const q3 = document.getElementById('share-q3'); if (q3) q3.hidden = true;
        const how = document.getElementById('share-how'); if (how) how.hidden = true;
        document.querySelectorAll('#file-share-scrim .share-q-num').forEach((el) => { el.style.visibility = 'hidden'; });
      });
      await sleep(300);
    },
    clip: FLOW,
    callouts: [
      { n: 1, selector: '.share-seg', place: 'r' },
      { n: 2, selector: '#share-people', place: 'r' },
      { n: 3, selector: '.share-flow > .share-q:nth-of-type(2)', place: 'r' },
    ],
    caption: 'Choosing who gets the file and what they can do',
  },
  // 2. Step 3 (How long and how locked): expiry date, password and send-files-back turned
  // on, scrolled down to also show the Send invite button.
  {
    id: 'share-lock',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    setup: async (page) => {
      await openDialog(page);
      await page.eval(() => shareSetWho('people'));
      // Same two recipients as share-people (marcus.chen@acme.example and
      // dana@northfield-clinic.example), so this reads as the next step of the same flow
      // instead of one invitee silently vanishing between the two pictures.
      await page.eval((emails) => { for (const e of emails) _shareEmails.push(e); renderShareChips(); },
        ['marcus.chen@acme.example', 'dana@northfield-clinic.example']);
      await page.click('#share-expiry-on');
      // Same expiry date as the existing link to Dana shown in 'share-access', so the date
      // carries through consistently across the chapter instead of appearing to change.
      // Build the input's YYYY-MM-DD from the LOCAL date, matching how the app's shareDate()
      // will format this same instant on the 'share-access' picture.
      await page.eval((iso) => {
        const dt = new Date(iso);
        const val = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        const d = document.getElementById('share-expiry-date'); if (d) d.value = val;
      }, DANA_EXPIRY_ISO);
      await page.click('#share-pw-on');
      await page.click('#share-pw');
      await page.type('harbor-2026');
      await page.click('#share-upload-on');
      await page.eval(() => document.getElementById('share-q3').scrollIntoView({ block: 'start' }));
      await sleep(300);
    },
    clip: MODAL,
    callouts: [
      { n: 1, selector: '#share-expiry-on', place: 'l' },
      { n: 2, selector: '#share-pw-on', place: 'l' },
      { n: 3, selector: '#share-upload-row', place: 'l' },
      { n: 4, selector: '#share-primary', place: 'l' },
    ],
    caption: 'Setting an expiry date, a password, and sending the invite',
  },
  // 3. Who has access: expanded to show the existing link to Dana Whitfield and its Revoke button.
  {
    id: 'share-access',
    theme: 'dark',
    route: '#/files/Proposals/2026',
    localStorage: MY,
    // After "Send invite to 2": Marcus now has the file (demo/fixtures/share-file-invited.js),
    // and Dana has her own link, so both people invited two pictures earlier show up here.
    world: 'share-file-invited',
    setup: async (page) => {
      await openDialog(page);
      await page.eval(() => { const d = document.getElementById('file-access-details'); if (d) d.open = true; });
      await sleep(300);
      // Open Marcus's row so the Revoke next to a person shows, as step 2 says.
      await page.click(`[data-acc-toggle="u:${world.PEOPLE.marcus.id}"]`);
      await sleep(300);
      await page.eval(() => document.getElementById('file-access-details').scrollIntoView({ block: 'start' }));
      await sleep(300);
      // Drop the small print that is not needed to follow these two steps (why the file has
      // this access, that admins can also open it, the "as of" timestamp), so the picture can
      // crop to just the access details instead of the whole dialog and read larger in print.
      await page.eval(() => {
        document.querySelectorAll('#file-access-list .file-share-hint, #file-access-list .ls-note')
          .forEach((el) => { el.style.display = 'none'; });
      });
      // Crop to the access details only: blank out the Create link button just above them
      // (it used to be sliced in half by the top edge), and stop above the Close button.
      await page.eval(() => {
        const foot = document.querySelector('#file-share-scrim .share-foot'); if (foot) foot.style.visibility = 'hidden';
        const r = document.getElementById('file-access-details').getBoundingClientRect();
        let m = document.getElementById('__clip_marker');
        if (!m) { m = document.createElement('div'); m.id = '__clip_marker'; m.style.cssText = 'position:fixed;pointer-events:none;z-index:-1'; document.body.appendChild(m); }
        const top = r.top - 48, bottom = r.bottom + 8, left = Math.max(0, r.left - 50);
        m.style.left = left + 'px'; m.style.top = top + 'px';
        m.style.width = (r.right + 50 - left) + 'px'; m.style.height = (bottom - top) + 'px';
        return true;
      });
    },
    clip: { selector: '#__clip_marker', pad: 0 },
    callouts: [
      { n: 1, selector: '#file-access-summary', place: 't' },
      { n: 2, selector: '#file-share-list .file-library-tool', place: 'l' },
    ],
    caption: 'Seeing who has access to the file, and revoking a link',
  },
];
