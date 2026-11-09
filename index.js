// Launcher untuk panel hosting (bot-hosting.net / Pterodactyl dsb.) yang
// menyalakan server dengan `node index.js` di root project, sementara
// entry asli bot ini adalah TypeScript di src/index.ts (dijalankan tsx,
// sama seperti `npm start`).
//
// Launcher ini meneruskan SEMUA stdio — termasuk stdin — ke proses anak,
// jadi dashboard + menu console bot tetap bisa dipakai dari console
// panel, dan sinyal matikan (SIGINT/SIGTERM) diteruskan dengan bersih.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(rootDir, 'src', 'index.ts');

if (!existsSync(tsxCli)) {
  console.error('[launcher] tsx belum terinstall — jalankan `npm install` dulu di folder project ini.');
  process.exit(1);
}

const child = spawn(process.execPath, [tsxCli, entry], {
  cwd: rootDir,
  stdio: 'inherit',
  env: process.env,
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', (err) => {
  console.error('[launcher] Gagal menyalakan bot:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
