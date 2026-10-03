'use strict';
// Migration 0019 switches in-browser editing off once on every install, and the row it
// writes must beat COLLABORA_ENABLED=true in an older .env. Requires a REAL, THROWAWAY
// Postgres (MEMEX_TEST_PG_URL); skipped otherwise.
const fs = require('fs');
const path = require('path');
const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(60000);

suite('the in-browser editing switch against real Postgres', () => {
  let db, settings, editorStatus;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrate = async () => {
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
  };
  const row = () => db.queryOne("SELECT value, updated_at FROM system_settings WHERE key = 'collabora_enabled'");

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    process.env.COLLABORA_ENABLED = 'true'; // what every older install's .env says
    db = require('../../lib/db');
    settings = require('../../lib/settings');
    editorStatus = require('../../lib/editorStatus');
  });
  beforeEach(async () => { await reset(); await migrate(); settings._reset(); });
  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  test('the migration lands the switch off, and the row beats the old .env line', async () => {
    expect((await row()).value).toBe('false');
    expect(await settings.getOrEnv('collabora_enabled')).toBe('false');
    expect(await editorStatus.switchedOn()).toBe(false);
  });

  test("an admin's choice stands: switching on stays on across a restart's migration run", async () => {
    await editorStatus.setSwitch(true, null);
    expect((await row()).value).toBe('true');
    await require('../../lib/migrations').run(); // the next startup
    expect((await row()).value).toBe('true');
    expect(await editorStatus.switchedOn()).toBe(true);
  });

  test('switching off writes the literal false rather than clearing the row', async () => {
    await editorStatus.setSwitch(true, null);
    await editorStatus.setSwitch(false, null);
    const r = await row();
    expect(r.value).toBe('false');
    expect(Date.now() - new Date(r.updated_at).getTime()).toBeLessThan(60_000);
    expect(await settings.getOrEnv('collabora_enabled')).toBe('false'); // not 'true' from the env
  });
});
