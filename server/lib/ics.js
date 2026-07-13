'use strict';
// Minimal RFC 5545 VCALENDAR builder for meeting invites. We emit a single VEVENT
// with METHOD:REQUEST so mail clients (Outlook, Google, Apple) render an
// accept/decline invitation and drop the event onto the recipient's calendar.
// Kept dependency-free and pure (all inputs explicit, incl. `now`) so it unit-tests
// without a clock or a mail transport.

// Escape TEXT values per RFC 5545 §3.3.11: backslash, semicolon, comma, newline.
function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// A property PARAM value (e.g. CN) can't carry the structural chars ; , : or a
// newline unquoted; strip them rather than risk a malformed line.
function paramValue(s) {
  return String(s == null ? '' : s).replace(/[";:,\r\n]/g, ' ').trim();
}

// UTC timestamp in iCalendar "basic" form: YYYYMMDDTHHMMSSZ.
function formatUtc(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) throw new Error('invalid date');
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}Z`;
}

// Fold content lines to <=75 octets with CRLF + a leading space, per §3.1.
// We fold on byte boundaries (UTF-8 aware) so multi-byte chars aren't split.
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte UTF-8 sequence: back up while the next byte is a
    // continuation byte (10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines carry a leading space, so 1 fewer content octet
  }
  return out.join('\r\n ');
}

// buildEvent({ uid, start, end, summary, description, location, url, organizer,
//   attendees, method, sequence, status, now }) -> ics string (CRLF-terminated).
// organizer/attendees: { email, name }. Throws on missing required inputs.
function buildEvent(opts) {
  const { uid, start, end, summary } = opts;
  if (!uid) throw new Error('uid required');
  if (!summary) throw new Error('summary required');
  const dtStart = formatUtc(start);
  const dtEnd = formatUtc(end);
  const method = (opts.method || 'REQUEST').toUpperCase();
  const status = (opts.status || 'CONFIRMED').toUpperCase();
  const sequence = Number.isInteger(opts.sequence) ? opts.sequence : 0;
  const stamp = formatUtc(opts.now || new Date());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ptech//Memex//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (opts.description) lines.push(`DESCRIPTION:${escapeText(opts.description)}`);
  if (opts.location) lines.push(`LOCATION:${escapeText(opts.location)}`);
  if (opts.url) lines.push(`URL:${escapeText(opts.url)}`);
  if (opts.organizer && opts.organizer.email) {
    const cn = paramValue(opts.organizer.name || opts.organizer.email);
    lines.push(`ORGANIZER;CN=${cn}:mailto:${paramValue(opts.organizer.email)}`);
  }
  for (const a of opts.attendees || []) {
    if (!a || !a.email) continue;
    const cn = paramValue(a.name || a.email);
    lines.push(`ATTENDEE;CN=${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${paramValue(a.email)}`);
  }
  lines.push(`SEQUENCE:${sequence}`);
  lines.push(`STATUS:${status}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { buildEvent, escapeText, paramValue, formatUtc, foldLine };
