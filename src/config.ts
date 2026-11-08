import { config as loadEnv } from 'dotenv';

loadEnv();

/**
 * Konfigurasi bot — semua dibaca dari environment / file `.env`.
 * Tidak ada nilai rahasia yang ditulis di dalam kode.
 */

export interface ActiveWindow {
  /** Label asli, mis. "08:00-12:00" (untuk log). */
  label: string;
  startMinutes: number;
  endMinutes: number;
}

export interface AiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface GroupConfig {
  /**
   * JID grup tujuan, format "120363xxxxxxxxxx@g.us".
   * Boleh kosong bila hanya memakai invite link — JID hasil join
   * akan ditemukan otomatis dari link tersebut.
   */
  jid: string;
  /** Kode undangan grup (atau link chat.whatsapp.com/... utuh). */
  inviteCode: string;
  /** Aktifkan percakapan antar-bot di dalam grup. */
  chatEnabled: boolean;
  /** Jeda antar sesi percakapan grup (menit, acak di rentang ini). */
  chatIntervalMinMinutes: number;
  chatIntervalMaxMinutes: number;
  /** Jumlah giliran bicara dalam satu sesi percakapan grup. */
  chatMinTurns: number;
  chatMaxTurns: number;
  /** Jeda ekstra antar giliran bicara di grup (milidetik, acak di rentang ini). */
  chatTurnGapMinMs: number;
  chatTurnGapMaxMs: number;
}

export interface BotConfig {
  /** Folder basis sesi: sesi akun <id> disimpan di <authBaseDir>/<id>/. */
  authBaseDir: string;
  /** File registry akun (JSON): daftar akun bot yang dikelola proses ini. */
  accountsFile: string;
  timezone: string;
  activeWindows: ActiveWindow[];
  group: GroupConfig;
  ai: AiConfig;
  thinkDelayMinMs: number;
  thinkDelayMaxMs: number;
  typingMsPerChar: number;
  typingMaxMs: number;
  markAsRead: boolean;
  respondToGroups: boolean;
  logLevel: string;
}

function parseTimeToMinutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error(`Format jam tidak valid: "${value}" (harus HH:MM, 24 jam)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseActiveWindows(raw: string): ActiveWindow[] {
  const windows = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [start, end, ...rest] = part.split('-');
      if (!start || !end || rest.length > 0) {
        throw new Error(`Format jendela aktif tidak valid: "${part}" (harus HH:MM-HH:MM)`);
      }
      return {
        label: `${start.trim()}-${end.trim()}`,
        startMinutes: parseTimeToMinutes(start),
        endMinutes: parseTimeToMinutes(end),
      };
    });
  if (windows.length === 0) throw new Error('ACTIVE_WINDOWS tidak boleh kosong');
  return windows;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} harus berupa angka, dapat: "${raw}"`);
  return value;
}

function floatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) throw new Error(`${name} harus berupa angka, dapat: "${raw}"`);
  return value;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Ambil kode undangan dari input `.env`: menerima kode mentah
 * ("AbCdEf123") maupun link utuh ("https://chat.whatsapp.com/AbCdEf123").
 */
export function extractInviteCode(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const linkMatch = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/.exec(value);
  if (linkMatch) return linkMatch[1] ?? '';
  return value.split(/[?\s]/)[0] ?? '';
}

export const config: BotConfig = {
  authBaseDir: process.env.AUTH_BASE_DIR?.trim() || 'auth_info',
  accountsFile: process.env.ACCOUNTS_FILE?.trim() || 'data/accounts.json',
  timezone: process.env.BOT_TIMEZONE?.trim() || 'Asia/Jakarta',
  activeWindows: parseActiveWindows(process.env.ACTIVE_WINDOWS ?? '08:00-12:00,16:00-20:00'),
  group: {
    jid: process.env.GROUP_JID?.trim() ?? '',
    inviteCode: extractInviteCode(process.env.GROUP_INVITE_CODE ?? process.env.GROUP_INVITE_LINK),
    chatEnabled: boolFromEnv('GROUP_CHAT_ENABLED', true),
    chatIntervalMinMinutes: intFromEnv('GROUP_CHAT_INTERVAL_MIN_MINUTES', 20),
    chatIntervalMaxMinutes: intFromEnv('GROUP_CHAT_INTERVAL_MAX_MINUTES', 45),
    chatMinTurns: intFromEnv('GROUP_CHAT_MIN_TURNS', 4),
    chatMaxTurns: intFromEnv('GROUP_CHAT_MAX_TURNS', 8),
    chatTurnGapMinMs: intFromEnv('GROUP_CHAT_TURN_GAP_MIN_MS', 4000),
    chatTurnGapMaxMs: intFromEnv('GROUP_CHAT_TURN_GAP_MAX_MS', 12000),
  },
  ai: {
    apiKey: process.env.AI_API_KEY?.trim() ?? '',
    baseURL: process.env.AI_BASE_URL?.trim() || 'https://api.groq.com/openai/v1',
    model: process.env.AI_MODEL?.trim() || 'llama-3.3-70b-versatile',
    temperature: floatFromEnv('AI_TEMPERATURE', 0.9),
    maxTokens: intFromEnv('AI_MAX_TOKENS', 120),
  },
  thinkDelayMinMs: intFromEnv('THINK_DELAY_MIN_MS', 3000),
  thinkDelayMaxMs: intFromEnv('THINK_DELAY_MAX_MS', 7000),
  typingMsPerChar: intFromEnv('TYPING_MS_PER_CHAR', 40),
  typingMaxMs: intFromEnv('TYPING_MAX_MS', 6000),
  markAsRead: boolFromEnv('MARK_AS_READ', true),
  respondToGroups: boolFromEnv('RESPOND_TO_GROUPS', false),
  logLevel: process.env.LOG_LEVEL?.trim() || 'silent',
};
