'use strict';
// Copy the built guide (the PDF) into the app, where it is served from
// /help/getting-started.pdf and copied into each new personal library
// (server/lib/gettingStarted.js). Run after `node build/all.js`, then commit
// server/assets/getting-started/ with the change.
//
// The edition being replaced is written into past-editions.json first. At its next start
// the server swaps every untouched copy of a listed edition for the new one, so people who
// already have the guide get the new edition too. Only the PDF ships: the Word file stays
// in out/ for anyone who wants to edit the text by hand.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { G } = require('./lib');

const name = 'Getting started with Depot.pdf';
const src = path.join(G, 'out', name);
const dest = path.join(G, '..', '..', 'server', 'assets', 'getting-started');
const target = path.join(dest, name);
const pastFile = path.join(dest, 'past-editions.json');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (!fs.existsSync(src)) {
  console.error(`missing ${src}: run node build/all.js first`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });

let past = {};
try { past = JSON.parse(fs.readFileSync(pastFile, 'utf8')); } catch { /* the first edition has no past */ }
past.pdf = Array.isArray(past.pdf) ? past.pdf : [];
past.word = Array.isArray(past.word) ? past.word : [];

const incoming = sha256(src);
if (fs.existsSync(target)) {
  const outgoing = sha256(target);
  if (outgoing !== incoming && !past.pdf.includes(outgoing)) {
    past.pdf.push(outgoing);
    console.log(`listed the outgoing edition (${outgoing.slice(0, 12)}...) in past-editions.json`);
  }
}
// An edition that is shipped again is the current one, not a past one.
past.pdf = past.pdf.filter((h) => h !== incoming);
fs.writeFileSync(pastFile, JSON.stringify(past, null, 2) + '\n');

fs.copyFileSync(src, target);
console.log(`copied ${name} (${Math.round(fs.statSync(src).size / 1024)} KB) -> server/assets/getting-started/`);
