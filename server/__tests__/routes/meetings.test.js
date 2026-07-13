'use strict';
// Covers POST /api/meetings: validation, the "known accounts only" guard against
// mail-relay abuse, and that each attendee is emailed a calendar invite carrying
// the deep-link room.
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', email: 'dave@x.com', name: 'Dave', role: 'admin' }; next(); });
jest.mock('../../lib/db', () => ({ query: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async (k) => (k === 'app_url' ? 'https://memex.example' : null)) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: true, via: 'graph' })) }));

const express = require('express');
const request = require('supertest');
const db = require('../../lib/db');
const email = require('../../lib/email');
const settings = require('../../lib/settings');
const meetings = require('../../routes/meetings');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/meetings', meetings);
  return a;
}

// dave, ann, sam have accounts; nobody@ does not.
function mockAccounts() {
  db.query.mockImplementation(async (sql) => {
    if (sql.includes('user_roles')) return [{ email: 'dave@x.com' }, { email: 'ann@x.com' }];
    if (sql.includes('user_profiles')) return [{ email: 'sam@x.com' }];
    return [];
  });
}

beforeEach(() => {
  db.query.mockReset(); email.sendMail.mockClear(); mockAccounts();
  settings.getOrEnv.mockImplementation(async (k) => (k === 'app_url' ? 'https://memex.example' : null));
});

const good = { title: 'Standup', start: '2026-07-20T15:00:00.000Z', durationMinutes: 30, attendees: ['ann@x.com', 'sam@x.com'] };

describe('POST /api/meetings', () => {
  test('emails a calendar invite with the deep link to each known attendee', async () => {
    const res = await request(app()).post('/api/meetings').send(good);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.room).toMatch(/^room-standup-[0-9a-f]{18}$/);
    expect(res.body.joinUrl).toBe(`https://memex.example/?meet=${encodeURIComponent(res.body.room)}`);
    expect(res.body.sentCount).toBe(2);
    expect(email.sendMail).toHaveBeenCalledTimes(2);
    const call = email.sendMail.mock.calls[0][0];
    expect(call.icalEvent.method).toBe('REQUEST');
    expect(call.icalEvent.content).toContain('BEGIN:VCALENDAR');
    expect(call.icalEvent.content).toContain(res.body.joinUrl);
    expect(call.subject).toContain('Standup');
  });

  test('drops attendees without a Memex account (anti-relay) and returns only counts (no enumeration oracle)', async () => {
    const res = await request(app()).post('/api/meetings').send({ ...good, attendees: ['ann@x.com', 'nobody@evil.com'] });
    expect(res.status).toBe(200);
    expect(res.body.sentCount).toBe(1);
    expect(res.body.skippedCount).toBe(1);
    // the response must never echo which specific addresses matched or didn't
    expect(JSON.stringify(res.body)).not.toContain('nobody@evil.com');
    expect(JSON.stringify(res.body)).not.toContain('ann@x.com');
    expect(email.sendMail).toHaveBeenCalledTimes(1);
  });

  test('400 when no attendee matches an account', async () => {
    const res = await request(app()).post('/api/meetings').send({ ...good, attendees: ['nobody@evil.com'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('nobody@evil.com');
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  test('400 when app_url is not configured (no request-Host-derived invite links)', async () => {
    settings.getOrEnv.mockImplementation(async () => null);
    const res = await request(app()).post('/api/meetings').send(good);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app URL/i);
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  test('400 on missing title or invalid start', async () => {
    expect((await request(app()).post('/api/meetings').send({ ...good, title: '' })).status).toBe(400);
    expect((await request(app()).post('/api/meetings').send({ ...good, start: 'nope' })).status).toBe(400);
  });

  test('defaults and clamps the duration', async () => {
    const res = await request(app()).post('/api/meetings').send({ ...good, durationMinutes: 99999 });
    expect(res.body.durationMinutes).toBe(1440);
  });
});
