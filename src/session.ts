import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Siklus hidup sesi multi-file auth Baileys.
 *
 * Kebijakan:
 * - Sesi yang TIDAK pernah selesai pairing (creds.json hilang / rusak /
 *   `registered` bukan true) tidak berguna — dan bila dibiarkan di disk bisa
 *   meracuni start berikutnya (WhatsApp menolak dengan 401 dan bot macet
 *   tanpa kode pairing baru). Sisa seperti ini dihapus otomatis supaya bot
 *   selalu mulai pairing dari keadaan bersih.
 * - Sesi yang SUDAH terdaftar selalu disimpan dan dipakai ulang, jadi bot
 *   tersambung kembali tanpa login ulang sampai ada logout eksplisit.
 */

export function isRegisteredSession(authDir: string): boolean {
  try {
    const raw = readFileSync(path.join(authDir, 'creds.json'), 'utf8');
    const creds = JSON.parse(raw) as { registered?: boolean };
    return creds?.registered === true;
  } catch {
    return false;
  }
}

export function wipeSession(authDir: string): void {
  try {
    rmSync(authDir, { recursive: true, force: true });
  } catch {
    /* best effort — file terkunci tidak boleh membuat bot crash */
  }
}

/**
 * Jalankan sekali saat proses start, sebelum koneksi pertama.
 * Mengembalikan true bila sesi terdaftar yang sudah ada akan dipakai ulang.
 * Sisa sesi setengah-pairing dihapus dan false dikembalikan.
 */
export function ensureUsableSession(authDir: string): boolean {
  if (!existsSync(authDir)) return false;
  if (isRegisteredSession(authDir)) return true;
  console.log('[sesi] Sesi lama tidak pernah selesai pairing — dihapus otomatis, mulai dari bersih.');
  wipeSession(authDir);
  return false;
}
