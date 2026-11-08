import { format } from 'node:util';
import { config } from './config.js';

/**
 * UI console (menu dashboard) bot-trainer.
 *
 * Saat proses hidup, yang tampil di console adalah SATU dashboard:
 * status bot, jadwal, AI, grup, daftar akun, log terakhir, log chat,
 * dan menu pilihan. Semua console.log/warn/error dari modul lain
 * DITANGKAP ke buffer log di sini (installConsoleCapture) supaya tidak
 * mengotori layar — isinya muncul di bagian "LOG TERAKHIR" dashboard
 * dan bisa dibuka penuh dari menu.
 *
 * Pengecualian: kode pairing. Kode pairing adalah hal yang harus
 * terlihat SAAT ITU JUGA, jadi showPairingCode() menulis langsung ke
 * stdout melewati buffer, apa pun keadaan menu saat itu.
 */

export interface AccountSnapshot {
  id: string;
  status: string;
  phoneNumber?: string;
  groupJid?: string;
  pairingNote?: string;
}

export interface DashboardSnapshot {
  now: Date;
  active: boolean;
  accounts: AccountSnapshot[];
  groupTarget: string;
  groupChatEnabled: boolean;
}

const MAX_LOG_ENTRIES = 300;
const logBuffer: string[] = [];

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
let captureInstalled = false;
let menuActive = false;

function timestamp(date = new Date()): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function pushLog(text: string): void {
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    logBuffer.push(`[${timestamp()}] ${line}`);
  }
  while (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
}

/** Aktifkan penangkapan console.* ke buffer log dashboard. */
export function installConsoleCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;
  const capture =
    (level: 'log' | 'info' | 'warn' | 'error') =>
    (...args: unknown[]): void => {
      const text = format(...args);
      pushLog(level === 'log' || level === 'info' ? text : `[${level}] ${text}`);
      if (!menuActive) {
        // Sebelum menu jalan (startup awal / error fatal), tulis apa adanya.
        originalStdoutWrite(`${text}\n`);
      }
    };
  console.log = capture('log');
  console.info = capture('info');
  console.warn = capture('warn');
  console.error = capture('error');
}

export function setMenuActive(active: boolean): void {
  menuActive = active;
}

/** Tulis langsung ke stdout, melewati buffer & keadaan menu. */
export function writeDirect(text: string): void {
  originalStdoutWrite(text.endsWith('\n') ? text : `${text}\n`);
}

/** Tulis prompt input apa adanya (tanpa newline di akhir). */
export function writeInline(text: string): void {
  originalStdoutWrite(text);
}

/** Kode pairing ditampilkan seketika, berbingkai jelas, berlabel akun. */
export function showPairingCode(accountId: string, phoneNumber: string, code: string): void {
  const line = '═'.repeat(46);
  const text = [
    '',
    `╔${line}╗`,
    `   🔑  KODE PAIRING — akun "${accountId}"`,
    `   📱  Nomor: +${phoneNumber}`,
    `       Kode: ${code}`,
    '   Masukkan di: WhatsApp → Perangkat tertaut →',
    '   Tautkan perangkat → "Tautkan dengan nomor telepon"',
    `╚${line}╝`,
    '',
  ].join('\n');
  pushLog(`🔑 Kode pairing akun "${accountId}" (+${phoneNumber}): ${code}`);
  writeDirect(text);
}

export function recentLogs(count: number): string[] {
  return logBuffer.slice(-count);
}

/** Log chat = entri DM (💬) dan ucapan/jawaban di grup ([grup] <akun>: …). */
export function recentChatLogs(count: number): string[] {
  return logBuffer
    .filter(
      (entry) =>
        entry.includes('💬') || /\[grup\] [\w-]+:/.test(entry) || entry.includes('menjawab manusia di grup'),
    )
    .slice(-count);
}

const WIDTH = 62;

function boxLine(content = ''): string {
  const text = content.length > WIDTH ? `${content.slice(0, WIDTH - 1)}…` : content;
  return `║ ${text.padEnd(WIDTH)} ║`;
}

function boxSeparator(): string {
  return `╠${'═'.repeat(WIDTH + 2)}╣`;
}

/** Render dashboard + menu utama ke stdout (langsung, bukan console.log). */
export function renderDashboard(snapshot: DashboardSnapshot): void {
  const timeLabel = new Intl.DateTimeFormat('id-ID', {
    timeZone: config.timezone,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(snapshot.now);

  const connected = snapshot.accounts.filter((account) => account.status === 'open').length;
  const lines: string[] = [];
  lines.push(`╔${'═'.repeat(WIDTH + 2)}╗`);
  lines.push(boxLine('🤖  BOT TRAINER — DASHBOARD'));
  lines.push(boxSeparator());
  lines.push(boxLine(`Waktu      : ${timeLabel} (${config.timezone})`));
  lines.push(
    boxLine(
      `Status bot : ${snapshot.active ? '☀️  AKTIF (jam aktif)' : '🌙 TIDUR (di luar jam aktif)'} | akun online: ${connected}/${snapshot.accounts.length}`,
    ),
  );
  lines.push(
    boxLine(
      `Jadwal     : ${config.activeWindows.map((window) => window.label).join(', ')}`,
    ),
  );
  lines.push(
    boxLine(
      config.ai.apiKey
        ? `AI         : ${config.ai.model} @ ${config.ai.baseURL}`
        : 'AI         : mode fallback (tanpa API key)',
    ),
  );
  lines.push(
    boxLine(
      `Grup       : ${snapshot.groupTarget || 'belum diatur di .env'} | chat grup: ${snapshot.groupChatEnabled ? 'ON' : 'OFF'}`,
    ),
  );
  lines.push(boxSeparator());
  lines.push(boxLine(`AKUN (${snapshot.accounts.length}):`));
  if (snapshot.accounts.length === 0) lines.push(boxLine('  (belum ada akun)'));
  for (const account of snapshot.accounts) {
    const statusLabel =
      account.status === 'open'
        ? '✅ terhubung'
        : account.status === 'waiting-pairing'
          ? '🔑 menunggu pairing'
          : account.status === 'needs-phone'
            ? '📱 belum ada nomor'
            : account.status;
    lines.push(
      boxLine(
        `  • ${account.id}: ${statusLabel}${account.phoneNumber ? ` | +${account.phoneNumber}` : ''}${account.groupJid ? ' | di grup ✓' : ''}${account.pairingNote ? ` | ${account.pairingNote}` : ''}`,
      ),
    );
  }
  lines.push(boxSeparator());
  lines.push(boxLine('LOG CHAT TERAKHIR:'));
  const chats = recentChatLogs(5);
  if (chats.length === 0) lines.push(boxLine('  (belum ada aktivitas chat)'));
  for (const entry of chats) lines.push(boxLine(`  ${entry.replace(/^\[[^\]]+\]\s*/, '')}`));
  lines.push(boxLine('LOG TERAKHIR:'));
  const logs = recentLogs(5);
  if (logs.length === 0) lines.push(boxLine('  (kosong)'));
  for (const entry of logs) lines.push(boxLine(`  ${entry}`));
  lines.push(boxSeparator());
  lines.push(boxLine('MENU:'));
  lines.push(boxLine('  1. Tambah akun baru (pairing code)'));
  lines.push(boxLine('  2. Pairing / sambungkan akun'));
  lines.push(boxLine('  3. Daftar akun & status'));
  lines.push(boxLine('  4. Log chat (30 terakhir)'));
  lines.push(boxLine('  5. Log sistem (30 terakhir)'));
  lines.push(boxLine('  6. Logout akun'));
  lines.push(boxLine('  7. Hapus akun'));
  lines.push(boxLine('  0. Keluar (matikan semua bot)'));
  lines.push(boxLine('  (Enter kosong = refresh dashboard)'));
  lines.push(`╚${'═'.repeat(WIDTH + 2)}╝`);

  // Di terminal beneran, bersihkan layar dulu agar dashboard terasa
  // seperti satu UI. Di pipa/panel, cukup cetak bloknya apa adanya.
  if (process.stdout.isTTY) originalStdoutWrite('\x1B[2J\x1B[H');
  writeDirect(lines.join('\n'));
}
