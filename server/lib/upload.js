'use strict';
const multer = require('multer');
const settings = require('./settings');

function makeUploadMiddleware(allowedExts, defaultMb) {
  let _cachedMb = null;
  let _cachedMw = null;

  return async function getUpload() {
    const mb = parseInt(await settings.getOrEnv('max_upload_mb') || String(defaultMb), 10);
    if (mb !== _cachedMb || !_cachedMw) {
      _cachedMb = mb;
      _cachedMw = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: mb * 1024 * 1024 },
        fileFilter(_req, file, cb) {
          const ext = '.' + file.originalname.split('.').pop().toLowerCase();
          cb(null, allowedExts.includes(ext));
        },
      }).single('file');
    }
    return _cachedMw;
  };
}

module.exports = { makeUploadMiddleware };
