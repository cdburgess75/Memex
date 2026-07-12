'use strict';
// Covers the tamper-evident hash chain: deterministic hashing, a valid chain
// verifies, and any mutation (contents, deletion/reorder, or a swapped link) is
// detected at the right entry.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));
const { hashEvent, verifyRows } = require('../../lib/auditLog');

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
});

describe('verifyRows', () => {
  test('a well-formed chain verifies', () => {
    const chain = buildChain(EVENTS);
    expect(verifyRows(chain)).toEqual({ ok: true, count: 3, head: chain[2].hash });
  });

  test('empty chain is ok', () => {
    expect(verifyRows([])).toEqual({ ok: true, count: 0, head: null });
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
