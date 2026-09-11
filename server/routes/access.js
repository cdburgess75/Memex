'use strict';
// Who has access, and why (piece 3) -- mounted at /api/access by server/index.js.
// Everything here only reads; what each list may show is decided in lib/accessKeys.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { serverError } = require('../lib/httpError');
const accessKeys = require('../lib/accessKeys');

// GET /api/access/shared-with-me -- libraries, folders and files shared with the caller
router.get('/shared-with-me', auth, async (req, res) => {
  try { res.json(await accessKeys.sharedWithMe(req.user)); } catch (e) { serverError(res, e); }
});

module.exports = router;
