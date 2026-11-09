import { config } from './config.js';

/**
 * UI console bot-trainer — MENU BIASA, tanpa dashboard.
 *
 * Console berperilaku seperti console program pada umumnya: semua log
 * modul (jadwal, akun, grup, chat) tercetak langsung apa adanya, dan di
 * atasnya ada satu menu bernomor sederhana:
 *
 *   1. Tambah akun            → tanya nama → tanya nomor → pairing
 *   2. Pairing / sambungkan akun
 *   3. Daftar akun & status
 *   4. Start / Stop sesi chat (satu tombol, labelnya mengikuti keadaan)
 *   5. Logout / hapus akun
 *   6. Keluar
 *
 * Satu-satunya tampilan khusus yang tersisa adalah KODE PAIRING
 * (showPairingCode): memang harus terlihat jelas saat itu juga supaya
 * bisa segera dimasukkan ke HP akun yang di-pairing.
 */

export interface AccountSnapshot {
  id: string;
  status: string;
  phoneNumber?: string;
  groupJid?: string;
  pairingNote?: string;
}

export interface MenuInfo {
  active: boolean;
  accounts: AccountSnapshot[];
  /** Sesi chat menyala (Start) atau berhenti (Stop) — lihat chat-session.ts. */
  sessionRunning: boolean;
}

/** Label status akun untuk daftar & menu. */
export function accountStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'terhubung';
    case 'waiting-pairing':
      return 'menunggu pairing';
    case 'needs-phone':
      return 'belum ada nomor';
    default:
      return status;
  }
}

/** Cetak menu utama (dipanggil ulang setiap selesai satu aksi). */
export function printMainMenu(info: MenuInfo): void {
  const connected = info.accounts.filter((account) => account.status === 'open').length;
  const lines = [
    '',
    '========== BOT TRAINER ==========',
    `Status : ${info.active ? 'AKTIF (jam aktif)' : 'TIDUR (di luar jam aktif)'} | jadwal: ${config.activeWindows.map((w) => w.label).join(', ')} (${config.timezone})`,
    `Sesi   : ${info.sessionRunning ? '▶ BERJALAN (bot mengobrol)' : '⏸ BERHENTI (bot diam, tetap terhubung)'}`,
    `AI     : ${config.ai.apiKey ? `${config.ai.model} @ Google Gemini` : 'mode fallback (tanpa API key)'}`,
    `Akun   : ${connected}/${info.accounts.length} online`,
    '',
    '1. Tambah akun',
    '2. Pairing / sambungkan akun',
    '3. Daftar akun & status',
    info.sessionRunning ? '4. Stop sesi chat' : '4. Start sesi chat',
    '5. Logout / hapus akun',
    '6. Keluar',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
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
  console.log(`🔑 Kode pairing akun "${accountId}" (+${phoneNumber}): ${code}`);
  process.stdout.write(`${text}\n`);
}
