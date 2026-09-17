'use strict';
// The stand-in for db.withTransaction in the mocked suites. The folder operations, and
// every placement of a document by name, run inside one transaction; this hands the
// callback a client backed by the suite's own query/queryOne mocks (a pg client answers
// { rows }).
//
// The lock's own plumbing (lib/folderLocks) answers itself: it is not something a test
// mocks, and letting it reach the mocks would consume their queued rows. It is RECORDED,
// though, in `locks` -- so a suite can say that a placement really asked for the library's
// tree lock, and in which mode. Without that, the lock can be deleted and every mocked
// suite stays green.
const PLUMBING = /^\s*(SET LOCAL|SELECT DISTINCT hashtext|SELECT pg_advisory)/i;

function txStandIn({ query = null, queryOne }) {
  const locks = [];
  const withTransaction = jest.fn(async (fn) => fn({
    query: async (sql, params = []) => {
      if (PLUMBING.test(sql)) {
        locks.push({ sql, params });
        // one key per library, as hashtext() would give -- or tree() has nothing to lock
        if (/SELECT DISTINCT hashtext/i.test(sql)) return { rows: (params[0] || []).map((_, i) => ({ k: i + 1 })) };
        return { rows: [] };
      }
      if (query) {
        const rows = await query(sql, params);
        if (rows && rows.length) return { rows };
        // the single-row mock answers reads, and the writes that RETURN what they wrote
        if (!/^\s*SELECT/i.test(sql) && !/RETURNING/i.test(sql)) return { rows: [] };
      }
      const one = await queryOne(sql, params);
      return { rows: one ? [one] : [] };
    },
  }));
  return { withTransaction, locks };
}

// Which tree locks were asked for since the last reset: [{ mode, ids }].
function treeLocks(locks) {
  const out = [];
  let ids = null;
  for (const l of locks) {
    if (/SELECT DISTINCT hashtext/i.test(l.sql)) ids = l.params[0];
    const m = /pg_advisory_xact_lock(_shared)?\(/i.exec(l.sql);
    if (m) out.push({ mode: m[1] ? 'shared' : 'exclusive', ids });
  }
  return out;
}

module.exports = { txStandIn, treeLocks };
