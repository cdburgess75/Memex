'use strict';
jest.mock('../../lib/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../lib/db');
const migrations = require('../../lib/migrations');

function tmpDirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('migrationFiles', () => {
  test('keeps only numbered .sql files, sorted lexically; ignores everything else', () => {
    const dir = tmpDirWith({
      '003_c.sql': '', '001_a.sql': '', '002_b.sql': '',
      'notes.txt': '', 'README.md': '', 'x.sql': '',
    });
    expect(migrations.migrationFiles(dir)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('run', () => {
  test('applies pending migrations in order, skips already-applied, records each', async () => {
    const dir = tmpDirWith({
      '002_b.sql': 'SELECT 2;', '001_a.sql': 'SELECT 1;', '010_c.sql': 'SELECT 10;', 'README.md': 'ignore me',
    });

    db.query.mockImplementation((sql) =>
      /SELECT name FROM schema_migrations/.test(sql)
        ? Promise.resolve([{ name: '001_a.sql' }]) // 001 already applied
        : Promise.resolve(undefined));

    const recorded = [];
    const ranSql = [];
    db.withTransaction.mockImplementation(async (fn) => {
      const client = { query: jest.fn((sql, params) => {
        if (/INSERT INTO schema_migrations/.test(sql)) recorded.push(params[0]);
        else ranSql.push(sql);
        return Promise.resolve({ rows: [] });
      }) };
      return fn(client);
    });

    const r = await migrations.run({ dir });

    expect(r.applied).toEqual(['002_b.sql', '010_c.sql']); // sorted, 001 skipped, README ignored
    expect(recorded).toEqual(['002_b.sql', '010_c.sql']);  // each recorded, in order
    expect(ranSql).toEqual(['SELECT 2;', 'SELECT 10;']);   // each file's SQL executed
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no-op when every migration is already applied', async () => {
    const dir = tmpDirWith({ '001_a.sql': 'SELECT 1;' });
    db.query.mockImplementation((sql) =>
      /SELECT name FROM schema_migrations/.test(sql)
        ? Promise.resolve([{ name: '001_a.sql' }])
        : Promise.resolve(undefined));

    const r = await migrations.run({ dir });

    expect(r.applied).toEqual([]);
    expect(db.withTransaction).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
