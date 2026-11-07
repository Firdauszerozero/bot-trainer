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

export interface BotConfig {
  /** Nomor pairing, digit saja (mis. "62812xxxxxxx"). Kosong bila belum diisi. */
  phoneNumber: string;
  authDir: string;
  timezone: string;
  activeWindows: ActiveWindow[];
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

/** Nomor dinormalisasi ke digit saja: "+62 812-345" -> "62812345". */
export function normalizePhone(raw: string | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

export const config: BotConfig = {
  phoneNumber: normalizePhone(process.env.BOT_PHONE_NUMBER),
  authDir: process.env.AUTH_DIR?.trim() || 'auth_info',
  timezone: process.env.BOT_TIMEZONE?.trim() || 'Asia/Jakarta',
  activeWindows: parseActiveWindows(process.env.ACTIVE_WINDOWS ?? '08:00-12:00,16:00-20:00'),
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
