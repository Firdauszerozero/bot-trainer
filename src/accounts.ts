import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Registry akun bot.
 *
 * Satu proses (satu VPS) mengelola BANYAK akun WhatsApp sekaligus.
 * Setiap akun punya:
 *   - id unik yang aman untuk nama folder (mis. "bot-1", "bot-2", "sinta")
 *   - folder sesi sendiri: <AUTH_BASE_DIR>/<id>/  (auth multi-file Baileys)
 *   - satu socket Baileys sendiri, dikelola AccountManager (index.ts)
 *
 * Daftar akun disimpan di ACCOUNTS_FILE (JSON) supaya akun yang pernah
 * ditambahkan lewat menu console tetap ada setelah restart. Nomor HP
 * tiap akun disimpan di sini juga — nomor itu yang dipakai meminta
 * pairing code saat akun belum punya sesi terdaftar. (Setelah akun
 * terhubung, nomor tampilannya tetap dibaca dari sesi socket.)
 */

export interface AccountRecord {
  id: string;
  /** Nomor HP akun (digit, format internasional) — dipakai meminta pairing code. */
  phoneNumber?: string;
  createdAt: string;
}

/**
 * Normalisasi nomor HP ke digit internasional:
 * "+62 812-3456" -> "628123456", "0812-3456" -> "628123456".
 * Mengembalikan undefined bila hasil akhirnya tidak masuk akal
 * (bukan 10–15 digit, atau diawali 0).
 */
export function normalizePhoneNumber(raw: string | undefined): string | undefined {
  let digits = (raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return undefined;
  return digits;
}

/** Id akun: huruf kecil, angka, dash, underscore. 1–32 karakter. */
export function sanitizeAccountId(raw: string): string | undefined {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id.length === 0 || id.length > 32) return undefined;
  return id;
}

/** Folder sesi (auth multi-file) milik satu akun. */
export function authDirFor(accountId: string): string {
  return path.join(config.authBaseDir, accountId);
}

export function loadAccounts(): AccountRecord[] {
  try {
    const raw = readFileSync(config.accountsFile, 'utf8');
    const parsed = JSON.parse(raw) as AccountRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is AccountRecord =>
          typeof entry?.id === 'string' && sanitizeAccountId(entry.id) === entry.id,
      )
      .map((entry) => ({ ...entry, phoneNumber: normalizePhoneNumber(entry.phoneNumber) }));
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: readonly AccountRecord[]): void {
  mkdirSync(path.dirname(config.accountsFile), { recursive: true });
  writeFileSync(config.accountsFile, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

/**
 * Muat registry; bila masih kosong (install baru), buat satu akun
 * bawaan "bot-1" supaya bot langsung bisa pairing QR pertama kali.
 */
export function loadOrCreateAccounts(): AccountRecord[] {
  const accounts = loadAccounts();
  if (accounts.length > 0) return accounts;
  const initial: AccountRecord[] = [{ id: 'bot-1', createdAt: new Date().toISOString() }];
  saveAccounts(initial);
  return initial;
}

/** Id otomatis berikutnya: bot-<n> terkecil yang belum terpakai. */
export function nextAccountId(existing: readonly AccountRecord[]): string {
  const used = new Set(existing.map((account) => account.id));
  let n = 1;
  while (used.has(`bot-${n}`)) n += 1;
  return `bot-${n}`;
}

export function accountsFileExists(): boolean {
  return existsSync(config.accountsFile);
}
