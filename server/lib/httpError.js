'use strict';

// Central 500 responder. The old pattern — res.status(500).json({ error: e.message })
// — leaked internal detail (pg errors, filesystem paths, driver messages) to the
// client and logged nothing, so most server errors on a customer box vanished
// silently. This logs the real error server-side (with the route for context, read
// from res.req so callers don't need `req` in scope) and returns a generic message.
// Validation errors (4xx) keep their own explicit messages — this is 500s only.
function serverError(res, err) {
  try {
    const req = res && res.req;
    const where = req ? `${req.method} ${req.originalUrl || req.url}` : '';
    console.error(`[500]${where ? ' ' + where : ''}`, err);
  } catch {
    // Logging must never mask the original failure.
  }
  if (res && !res.headersSent) res.status(500).json({ error: 'Internal error' });
}

module.exports = { serverError };
