'use strict';
// Covers the iCalendar builder: UTC formatting, TEXT escaping, RFC-5545 line
// folding, and the overall VEVENT/VCALENDAR shape used for meeting invites.
const ics = require('../../lib/ics');

const START = new Date('2026-07-20T15:00:00.000Z');
const END = new Date('2026-07-20T15:30:00.000Z');
const NOW = new Date('2026-07-12T12:00:00.000Z');

function base(extra = {}) {
  return ics.buildEvent({
    uid: 'abc-123@memex', start: START, end: END, summary: 'Weekly standup',
    organizer: { email: 'dave@x.com', name: 'Dave' },
    attendees: [{ email: 'ann@x.com' }, { email: 'sam@x.com', name: 'Sam' }],
    url: 'https://memex.example/?meet=room-standup-a1b2c3',
    now: NOW, ...extra,
  });
}

describe('formatUtc', () => {
  test('emits YYYYMMDDTHHMMSSZ in UTC', () => {
    expect(ics.formatUtc(START)).toBe('20260720T150000Z');
  });
  test('throws on an invalid date', () => {
    expect(() => ics.formatUtc('not-a-date')).toThrow(/invalid date/);
  });
});

describe('escapeText', () => {
  test('escapes backslash, semicolon, comma, and newlines', () => {
    expect(ics.escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });
});

describe('buildEvent', () => {
  const out = base();

  test('wraps a single VEVENT in a VCALENDAR with METHOD:REQUEST', () => {
    expect(out).toContain('BEGIN:VCALENDAR');
    expect(out).toContain('METHOD:REQUEST');
    expect(out).toContain('BEGIN:VEVENT');
    expect(out).toContain('END:VEVENT');
    expect(out.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  test('carries UID, DTSTAMP, DTSTART, DTEND, SUMMARY', () => {
    expect(out).toContain('UID:abc-123@memex');
    expect(out).toContain('DTSTAMP:20260712T120000Z');
    expect(out).toContain('DTSTART:20260720T150000Z');
    expect(out).toContain('DTEND:20260720T153000Z');
    expect(out).toContain('SUMMARY:Weekly standup');
  });

  test('emits organizer and one ATTENDEE line per invitee', () => {
    // Long property lines are folded (CRLF + space); unfold before matching content.
    const unfolded = out.replace(/\r\n /g, '');
    expect(unfolded).toContain('ORGANIZER;CN=Dave:mailto:dave@x.com');
    expect(unfolded).toContain('ATTENDEE;CN=ann@x.com;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@x.com');
    expect(unfolded).toContain(':mailto:sam@x.com');
    expect((unfolded.match(/ATTENDEE;/g) || []).length).toBe(2);
  });

  test('lines are CRLF-terminated', () => {
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/); // every LF preceded by CR
  });

  test('escapes a comma-bearing summary so it cannot break the line', () => {
    const o = base({ summary: 'Standup, and demo' });
    expect(o).toContain('SUMMARY:Standup\\, and demo');
  });

  test('folds a long line to <=75 octets with a leading space on continuations', () => {
    const o = base({ summary: 'X'.repeat(200) });
    expect(o).toContain('\r\n '); // a fold happened
    for (const line of o.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  test('requires uid and summary and a valid date', () => {
    expect(() => ics.buildEvent({ start: START, end: END, summary: 's' })).toThrow(/uid/);
    expect(() => ics.buildEvent({ uid: 'u', start: START, end: END })).toThrow(/summary/);
    expect(() => ics.buildEvent({ uid: 'u', start: 'bad', end: END, summary: 's' })).toThrow(/invalid date/);
  });
});
