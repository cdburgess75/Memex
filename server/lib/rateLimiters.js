'use strict';
const { rateLimit } = require('express-rate-limit');

// The authenticated bulk-upload routes issue one request per file (and per chunk
// for resumable uploads), so a legitimate folder of hundreds of files would blow
// past the general 300/window API cap and 429 mid-batch. These paths get their own
// high limiter instead, and the general limiter skips them. (Public upload-link and
// upload-links routes are deliberately NOT matched — they stay under the normal cap.)
const UPLOAD_PATH_RE = /^\/api\/files\/(upload-stream|uploads|upload)(\/|$)/;
function isUploadPath(req) {
  return UPLOAD_PATH_RE.test(String(req.originalUrl || req.url || '').split('?')[0]);
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function rateLimitEnabled() {
  return process.env.RATE_LIMIT_ENABLED !== 'false';
}

function createLimiter(options) {
  if (!rateLimitEnabled()) return (_req, _res, next) => next();
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: options.message },
    ...options,
  });
}

function makeRateLimiters() {
  const windowMs = intFromEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
  const shareWindowMs = intFromEnv('RATE_LIMIT_SHARE_WINDOW_MS', windowMs);
  return {
    apiLimiter: createLimiter({
      windowMs,
      limit: intFromEnv('RATE_LIMIT_API_MAX', 300),
      message: 'Too many requests. Please slow down and try again shortly.',
      skip: isUploadPath, // bulk-upload routes use uploadLimiter instead
    }),
    uploadLimiter: createLimiter({
      windowMs,
      limit: intFromEnv('RATE_LIMIT_UPLOAD_MAX', 5000),
      message: 'Too many upload requests. Please slow down and try again shortly.',
    }),
    authLimiter: createLimiter({
      windowMs,
      limit: intFromEnv('RATE_LIMIT_AUTH_MAX', 20),
      message: 'Too many login attempts. Please wait and try again shortly.',
    }),
    shareLimiter: createLimiter({
      windowMs: shareWindowMs,
      limit: intFromEnv('RATE_LIMIT_SHARE_MAX', 60),
      message: 'Too many share-link attempts. Please wait and try again shortly.',
    }),
  };
}

module.exports = { intFromEnv, rateLimitEnabled, makeRateLimiters, UPLOAD_PATH_RE, isUploadPath };
