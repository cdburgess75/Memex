'use strict';
// Help that anyone can read, signed in or not: the getting-started guide (the same PDF
// that is copied into each personal library), opened from the account menu. Viewers have
// no library to find their copy in, and anyone may have deleted theirs. Nothing private.
const express = require('express');
const gettingStarted = require('../lib/gettingStarted');

const router = express.Router();

router.get('/getting-started.pdf', (_req, res) => {
  // The PDF headers go with the file only: a build without the guide answers a plain 404.
  res.sendFile(gettingStarted.pdfPath(), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="Getting started with Depot.pdf"',
      'Cache-Control': 'no-cache',
    },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('The getting-started guide is not part of this build.');
  });
});

module.exports = router;
