'use strict';
// Copy the built guide into the app, where it is served from /help/getting-started.pdf and
// copied into each new personal library (server/lib/gettingStarted.js). Run after
// `node build/all.js`, then commit server/assets/getting-started/ with the change.
// Existing people's copies are never replaced; only new libraries get the new edition.
const fs = require('fs');
const path = require('path');
const { G } = require('./lib');
const dest = path.join(G, '..', '..', 'server', 'assets', 'getting-started');
fs.mkdirSync(dest, { recursive: true });
for (const ext of ['pdf', 'docx']) {
  const name = `Getting started with Depot.${ext}`;
  const src = path.join(G, 'out', name);
  if (!fs.existsSync(src)) { console.error(`missing ${src}: run node build/all.js first`); process.exitCode = 1; continue; }
  fs.copyFileSync(src, path.join(dest, name));
  console.log(`copied ${name} (${Math.round(fs.statSync(src).size / 1024)} KB) -> server/assets/getting-started/`);
}
