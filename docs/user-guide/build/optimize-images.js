'use strict';
// Print-size copies of the screenshots. The captures are taken at 2x (2880 px wide for a
// desktop screen), which is far more than a picture printed 6.5 inches wide needs, and
// every person's library carries its own copy of the guide. So before a build, each
// picture is scaled down to at most MAX_W pixels wide (about 245 dpi at full width) and
// stored as a palette PNG, which suits flat interface screenshots. The layout still sizes
// every picture from the ORIGINAL capture, so pages do not move; only the bytes shrink.
// Copies live in out/print-images/ and are redone only when their capture is newer.
// sharp is optional: without it the build embeds the originals and says so.
const fs = require('fs');
const path = require('path');

const MAX_W = 1600;      // Word copy
const MAX_W_PDF = 1300;  // PDF copy: about 200 dpi at the full 6.5 in width

function printCopyPath(imagesDir, file) {
  return path.join(imagesDir, '..', 'print-images', path.relative(imagesDir, file));
}

async function optimizeImages({ imagesDir, log = console.log } = {}) {
  let sharp;
  try { sharp = require('sharp'); } catch { log('  images: sharp is not installed; embedding full-size captures (npm install in docs/user-guide)'); return { made: 0, skipped: 0 }; }
  let made = 0, skipped = 0, before = 0, after = 0;
  if (!fs.existsSync(imagesDir)) return { made, skipped };
  for (const dir of fs.readdirSync(imagesDir)) {
    const full = path.join(imagesDir, dir);
    if (dir.startsWith('_') || !fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).filter(n => n.endsWith('.png'))) {
      const src = path.join(full, f);
      const dst = printCopyPath(imagesDir, src);
      const jpg = dst.replace(/\.png$/, '.jpg');
      const srcStat = fs.statSync(src);
      const fresh = (f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= srcStat.mtimeMs;
      if (fresh(dst) && fresh(jpg)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const scaled = () => sharp(src).resize({ width: MAX_W, withoutEnlargement: true });
      // Word: a palette PNG (Word keeps the file as given).
      await scaled().png({ palette: true, quality: 95, dither: 0.5, effort: 8, compressionLevel: 9 }).toFile(dst);
      // PDF: Chrome re-encodes PNGs when it prints but passes JPEGs through untouched, so
      // the PDF gets a high-quality JPEG with full colour detail (no chroma subsampling,
      // which would blur coloured text).
      await sharp(src).resize({ width: MAX_W_PDF, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(jpg);
      before += srcStat.size; after += fs.statSync(dst).size; made++;
    }
  }
  if (made) log(`  images: ${made} print copies made (${Math.round(before / 1048576)} MB -> ${Math.round(after / 1048576 * 10) / 10} MB)`);
  return { made, skipped };
}

module.exports = { optimizeImages, printCopyPath, MAX_W, MAX_W_PDF };
