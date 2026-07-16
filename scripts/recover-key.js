#!/usr/bin/env node
'use strict';
// Recover the at-rest storage encryption key from a backup's encryption-key.enc,
// using the backup passphrase. Prints the key to stdout so you can put it back into
// STORAGE_ENCRYPTION_KEY in .env during a restore.
//
//   MEMEX_BACKUP_KEY_PASSPHRASE='your passphrase' \
//     node scripts/recover-key.js /path/to/encryption-key.enc
//
const fs = require('fs');
const { unwrapKeyWithPassphrase } = require('../server/lib/backup');

const file = process.argv[2];
const pass = process.env.MEMEX_BACKUP_KEY_PASSPHRASE;
if (!file || !pass) {
  console.error("Usage: MEMEX_BACKUP_KEY_PASSPHRASE='...' node scripts/recover-key.js <encryption-key.enc>");
  process.exit(2);
}
try {
  process.stdout.write(unwrapKeyWithPassphrase(fs.readFileSync(file, 'utf8'), pass) + '\n');
} catch (e) {
  console.error('Recovery failed (wrong passphrase or corrupt file):', e.message);
  process.exit(1);
}
