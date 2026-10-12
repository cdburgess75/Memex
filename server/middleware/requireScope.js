'use strict';
// What a public-API request may do. A token carries the scope it was made with; an ordinary
// sign-in has the most its role allows (lib/apiTokens.effectiveScope). 'admin' also needs
// the person to be an administrator: a token cannot grant what its owner does not have.
const { effectiveScope, scopeCovers } = require('../lib/apiTokens');

module.exports = function requireScope(need) {
  return (req, res, next) => {
    const have = effectiveScope(req.user, req.apiToken);
    if (!scopeCovers(have, need)) {
      return res.status(403).json({ error: req.apiToken
        ? `This token has ${have} scope; this needs ${need}`
        : 'Insufficient permissions' });
    }
    if (need === 'admin' && req.user?.role !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
};
