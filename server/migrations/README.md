# Schema migrations

Forward-only, ordered, recorded schema changes. On startup, `server/lib/migrations.js`
applies every `*.sql` file here that hasn't run yet, in filename order, each inside its
own transaction, and records it in the `schema_migrations` table so it runs exactly once.

## Adding a migration

Create a file named with a zero-padded number and a short description:

```
0001_add_widgets_table.sql
0002_add_documents_archived_flag.sql
```

- Start the name with a digit and end it in `.sql` (other files, like this README, are ignored).
- Zero-pad so ordering stays stable past 9.
- Write plain SQL. It runs in a transaction with its bookkeeping insert, so a failure
  rolls the whole file back and stops the run.
- Prefer idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so a
  migration is safe even against a database that already had the change applied by the
  older scattered startup DDL.

## Changing a migration that has already shipped

Normally: don't. The runner records each file **by name** in `schema_migrations` and never
runs a recorded file again, so an edit reaches only databases that have not run it yet.
A schema change an existing box needs therefore always goes in a **new** file.

The one case where editing is right is the opposite: something a migration did that must
**stop happening** on new databases and **cannot be undone** on old ones without deleting
data. `0004` seeding an ownerless library named for one company is that case (removed
2026-10-25): a new file could not stop 0004 from running first on a fresh install, and
nothing may delete a library that an existing box has been using. When you do edit one,
say so in the file itself and make the surviving statements safe on both kinds of database.

## Drilling

Migrations run against the live database at startup and can't be fully exercised without
one. Drill a new migration against a throwaway stack (or a scratch Postgres) before
releasing it.
