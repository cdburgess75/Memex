const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  const name = req.user.user_metadata?.full_name ?? req.user.email;
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    name,
  });
});

module.exports = router;
