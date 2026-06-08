'use strict';
const { rateLimit } = require('express-rate-limit');

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
  return {
    apiLimiter: createLimiter({
      windowMs,
      limit: intFromEnv('RATE_LIMIT_API_MAX', 300),
      message: 'Too many requests. Please slow down and try again shortly.',
    }),
    authLimiter: createLimiter({
      windowMs,
      limit: intFromEnv('RATE_LIMIT_AUTH_MAX', 20),
      message: 'Too many login attempts. Please wait and try again shortly.',
    }),
  };
}

module.exports = { intFromEnv, rateLimitEnabled, makeRateLimiters };
