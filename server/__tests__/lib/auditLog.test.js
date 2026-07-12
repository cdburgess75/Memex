'use strict';
// Covers the tamper-evident hash chain: deterministic hashing, a valid chain
// verifies, and any mutation (contents, deletion/reorder, or a swapped link) is
// detected at the right entry.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));
const { hashEvent, verifyRows, normId } = require('../../lib/auditLog');

// Build a well-formed chain from a list of event field-sets.
function buildChain(events) {
  let prev = '';
  return events.map((e, i) => {
    const row = { chain_seq: i + 1, event_type: e.t, actor_email: e.a || '', document_id: e.d || '', detail: e.x || '', ts_ms: e.ms };
    row.prev_hash = prev;
    row.hash = hashEvent(prev, row);
    prev = row.hash;
    return row;
  });
}

const EVENTS = [
  { t: 'uploaded', a: 'dave@x.com', d: 'doc-1', x: '10 KB', ms: 1000 },
  { t: 'share_created', a: 'dave@x.com', d: 'doc-1', x: 'link', ms: 2000 },
  { t: 'share_downloaded', a: 'anon', d: 'doc-1', x: 'ip 1.2.3.4', ms: 3000 },
];

describe('hashEvent', () => {
  test('is deterministic and depends on prev_hash', () => {
    const row = { event_type: 'uploaded', actor_email: 'a@b.com', document_id: 'd', detail: 'x', ts_ms: 1 };
    expect(hashEvent('', row)).toBe(hashEvent('', row));
    expect(hashEvent('abc', row)).not.toBe(hashEvent('', row));
  });
  test('changes when any hashed field changes', () => {
    const base = { event_type: 'uploaded', actor_email: 'a@b.com', document_id: 'd', detail: 'x', ts_ms: 1 };
    const h = hashEvent('p', base);
    expect(hashEvent('p', { ...base, detail: 'y' })).not.toBe(h);
    expect(hashEvent('p', { ...base, ts_ms: 2 })).not.toBe(h);
    expect(hashEvent('p', { ...base, actor_email: 'z@b.com' })).not.toBe(h);
  });
  test('document_id is normalized so a mixed-case UUID hashes the same as its canonical form', () => {
    const upper = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11';
    const lower = upper.toLowerCase();
    expect(normId(upper)).toBe(lower);
    const row = { event_type: 'share_revoked', actor_email: 'a@b.com', detail: 'x', ts_ms: 1 };
    // append hashes the raw (upper) input; verify hashes the DB-canonical (lower).
    expect(hashEvent('p', { ...row, document_id: upper })).toBe(hashEvent('p', { ...row, document_id: lower }));
  });
});

describe('verifyRows', () => {
  test('a well-formed chain verifies and returns the running head', () => {
    const chain = buildChain(EVENTS);
    expect(verifyRows(chain)).toEqual({ ok: true, prev: chain[2].hash });
  });

  test('empty batch carries the prior head through', () => {
    expect(verifyRows([])).toEqual({ ok: true, prev: '' });
    expect(verifyRows([], 'abc')).toEqual({ ok: true, prev: 'abc' });
  });

  test('batches chain across calls via startPrev (keyset pagination)', () => {
    const chain = buildChain(EVENTS);
    const first = verifyRows(chain.slice(0, 2), '');
    expect(first.ok).toBe(true);
    const second = verifyRows(chain.slice(2), first.prev);
    expect(second).toEqual({ ok: true, prev: chain[2].hash });
  });

  test('detects a mutated field (hash no longer matches contents)', () => {
    const chain = buildChain(EVENTS);
    chain[1].detail = 'tampered'; // change contents without recomputing hash
    const r = verifyRows(chain);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(2);
    expect(r.reason).toMatch(/hash/);
  });

  test('detects a deleted entry (prev_hash link breaks)', () => {
    const chain = buildChain(EVENTS);
    const withHole = [chain[0], chain[2]]; // entry 2 removed
    const r = verifyRows(withHole);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(3);
    expect(r.reason).toMatch(/previous entry/);
  });

  test('detects a re-linked/forged prev_hash', () => {
    const chain = buildChain(EVENTS);
    chain[2].prev_hash = chain[0].hash; // point entry 3 at the wrong parent
    const r = verifyRows(chain);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(3);
  });
});
