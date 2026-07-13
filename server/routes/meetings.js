'use strict';
// Schedule an internal video meeting: pick a time + attendees, and Memex emails
// each a calendar invite (.ics, METHOD:REQUEST) carrying a deep link into the
// built-in WebRTC room. The room is ad-hoc (no persistence needed — a named room
// exists the moment someone joins it), so the recipient's own calendar holds the
// schedule and reminders. Attendees are restricted to KNOWN Memex accounts so this
// endpoint can't be abused as an open mail relay.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../lib/db');
const settings = require('../lib/settings');
const email = require('../lib/email');
const ics = require('../lib/ics');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lc = (s) => String(s || '').trim().toLowerCase();

// Base URL for the join link. Invite links are EMAILED to people, so they must be
// the canonical, externally reachable URL — we require the configured app_url and
// never derive it from the (spoofable) request Host, which would let a forged Host
// plant a phishing link inside an otherwise trusted invite.
async function configuredBase() {
  return String((await settings.getOrEnv('app_url')) || '').replace(/\/$/, '');
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// The set of emails that belong to real accounts (role holders + profiles).
async function knownEmails() {
  const set = new Set();
  try {
    const [roles, profiles] = await Promise.all([
      db.query('SELECT email FROM user_roles'),
      db.query('SELECT email FROM user_profiles'),
    ]);
    for (const r of roles) if (r.email) set.add(lc(r.email));
    for (const p of profiles) if (p.email) set.add(lc(p.email));
  } catch { /* fall through — empty set rejects everyone, which fails safe */ }
  return set;
}

// POST /api/meetings — create a meeting and email invites.
// body: { title, start (ISO), durationMinutes?, attendees:[email], description?, room? }
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    // Invite links must be the canonical external URL (they're emailed out).
    const appUrl = await configuredBase();
    if (!appUrl) return res.status(400).json({ error: 'Set the app URL in Settings before scheduling meetings — invite links must be externally reachable.' });

    const title = String(req.body?.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'title required' });

    const start = new Date(req.body?.start);
    if (isNaN(start.getTime())) return res.status(400).json({ error: 'valid start time required' });
    // Bound the start to a sane window: no more than a day in the past, at most two
    // years out. Keeps a bogus/extreme year from producing a malformed DTSTART while
    // the route still reports success.
    const nowMs = Date.now();
    if (start.getTime() < nowMs - 24 * 3600 * 1000 || start.getTime() > nowMs + 2 * 365 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'start time must be within the next two years' });
    }

    let duration = Number(req.body?.durationMinutes);
    if (!Number.isFinite(duration) || duration < 1) duration = 30;
    duration = Math.min(Math.round(duration), 24 * 60);
    const end = new Date(start.getTime() + duration * 60000);

    const description = String(req.body?.description || '').trim().slice(0, 2000);

    // Attendees: dedupe, validate shape, then keep only known accounts.
    const requested = Array.isArray(req.body?.attendees) ? req.body.attendees : [];
    const wanted = [...new Set(requested.map(lc).filter((e) => EMAIL_RE.test(e)))];
    if (!wanted.length) return res.status(400).json({ error: 'at least one attendee required' });
    const known = await knownEmails();
    const attendees = wanted.filter((e) => known.has(e));
    const skipped = wanted.filter((e) => !known.has(e));
    if (!attendees.length) {
      return res.status(400).json({ error: 'no attendees match a Memex account' });
    }

    // Room id (ad-hoc). Honor a caller-provided slug, else derive from the title;
    // always suffix random so two meetings never collide on a shared room.
    // The room name is the only gate on the ad-hoc WebRTC room, so give the suffix
    // real entropy (72 bits) rather than a guessable 6 hex chars.
    const base = slugify(req.body?.room || title) || 'meeting';
    const room = `room-${base}-${crypto.randomBytes(9).toString('hex')}`;
    const joinUrl = `${appUrl}/?meet=${encodeURIComponent(room)}`;

    const organizer = { email: req.user.email, name: req.user.name || req.user.email };
    const uid = `${crypto.randomUUID()}@memex`;
    const when = start.toUTCString();
    const bodyText =
      `${organizer.name} invited you to a Memex video meeting.\n\n` +
      `${title}\n${when} (${duration} min)\n\n` +
      (description ? `${description}\n\n` : '') +
      `Join: ${joinUrl}\n\n` +
      `The link opens Memex and drops you straight into the meeting room.`;

    const icsContent = ics.buildEvent({
      uid,
      start,
      end,
      summary: title,
      description: `${description ? description + '\n\n' : ''}Join the meeting: ${joinUrl}`,
      location: joinUrl,
      url: joinUrl,
      organizer,
      attendees: attendees.map((e) => ({ email: e })),
      method: 'REQUEST',
      now: new Date(),
    });

    const results = await Promise.all(attendees.map(async (to) => {
      const r = await email.sendMail({
        to,
        subject: `Invitation: ${title}`,
        text: bodyText,
        icalEvent: { method: 'REQUEST', filename: 'invite.ics', content: icsContent },
      });
      return { to, ...r };
    }));

    // Return COUNTS only — never echo which specific addresses matched (or didn't)
    // a Memex account, so this endpoint can't be used as a directory-enumeration
    // oracle. The organizer supplied the addresses; a summary is enough feedback.
    const sentCount = results.filter((r) => r.sent).length;
    res.json({
      ok: true, room, joinUrl, start: start.toISOString(), durationMinutes: duration,
      sentCount, failedCount: results.length - sentCount, skippedCount: skipped.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.slugify = slugify;
