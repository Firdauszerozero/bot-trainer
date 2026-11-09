// Dijalankan otomatis sesudah `npm install` (lihat "postinstall" di
// package.json). Sebagian panel hosting memasang dependency dengan
// install-scripts terblokir, sehingga binary esbuild (dipakai tsx untuk
// menjalankan TypeScript) bisa kehilangan izin eksekusi dan bot gagal
// menyala. Script ini memperbaikinya — dan TIDAK PERNAH menggagalkan
// instalasi bila ada yang tidak beres.
const { chmodSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

try {
  const esbuildDir = path.join(__dirname, '..', 'node_modules', '@esbuild');
  if (existsSync(esbuildDir)) {
    for (const platform of readdirSync(esbuildDir)) {
      const bin = path.join(esbuildDir, platform, 'bin', 'esbuild');
      if (existsSync(bin)) {
        chmodSync(bin, 0o755);
        console.log(`[postinstall] izin eksekusi diperbaiki: @esbuild/${platform}/bin/esbuild`);
      }
    }
  }
} catch (err) {
  console.warn('[postinstall] dilewati:', err && err.message ? err.message : err);
}
