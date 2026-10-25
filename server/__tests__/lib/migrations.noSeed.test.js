'use strict';
// No migration makes a library for anybody. Depot once seeded one on every install --
// ownerless, named for the company it was first built for -- so a new customer's first
// screen carried another company's name and unaddressed uploads landed in a place nobody
// owned. A library is somebody's: it is made at a person's first sign-in or on purpose on
// the website. This pins that no migration file, and nothing in the initial schema, puts
// one there again.
const fs = require('fs');
const path = require('path');
const { migrationFiles, DIR } = require('../../lib/migrations');

const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const files = migrationFiles();

test('there are migrations to check', () => {
  expect(files.length).toBeGreaterThan(20);
});

test.each(files)('%s inserts into libraries only with an owner', (name) => {
  const sql = read(name).replace(/--[^\n]*/g, ''); // comments may say anything
  for (const m of sql.matchAll(/INSERT\s+INTO\s+libraries\s*\(([^)]*)\)/gi)) {
    const cols = m[1].split(',').map(c => c.trim().toLowerCase());
    expect(cols).toContain('owner_id');
  }
});

test('nothing in the migrations or the initial schema names the company Depot was built for', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8');
  for (const text of [schema, ...files.map(read)]) expect(text).not.toMatch(/ptech/i);
});

test('0004 adopts documents that predate libraries only when there is a library to adopt them into', () => {
  const sql = read('0004_runtime_ensure_tables.sql');
  expect(sql).not.toMatch(/INSERT\s+INTO\s+libraries/i);
  expect(sql).toMatch(/UPDATE documents\s+SET library_id = \(SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1\)\s+WHERE library_id IS NULL\s+AND EXISTS \(SELECT 1 FROM libraries\);/);
});

test('the initial schema does not seed a library either', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  expect(schema).not.toMatch(/INSERT\s+INTO\s+libraries/i);
});
