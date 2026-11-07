import type { makeWASocket, WAMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';

/**
 * Logika jeda human-like.
 *
 * Urutan membalas satu pesan (meniru manusia membaca lalu mengetik):
 *   1. Jeda berpikir acak THINK_DELAY_MIN_MS..THINK_DELAY_MAX_MS
 *      (default 3000–7000 ms) — bot TIDAK langsung membalas.
 *   2. Presence 'composing' (status "sedang mengetik…") dikirim.
 *   3. Durasi mengetik dihitung dari panjang teks balasan
 *      (panjang × TYPING_MS_PER_CHAR, dengan jitter acak,
 *      dibatasi maksimal TYPING_MAX_MS — default 6000 ms).
 *   4. Pesan dikirim, lalu presence dimatikan ('paused').
 */

type Socket = ReturnType<typeof makeWASocket>;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomIntInclusive(min: number, max: number): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(Math.random() * (high - low + 1));
}

/** Jeda berpikir acak sebelum mulai merespons (default 3–7 detik). */
export function thinkingDelayMs(): number {
  return randomIntInclusive(config.thinkDelayMinMs, config.thinkDelayMaxMs);
}

/**
 * Durasi status mengetik untuk teks sepanjang ini.
 * Semakin panjang teks semakin lama, maksimal `typingMaxMs` (default 6 detik),
 * minimal 700 ms supaya ketikan sangat pendek pun tidak terlihat instan.
 */
export function typingDurationMs(text: string): number {
  const base = text.length * config.typingMsPerChar;
  const jitter = 0.85 + Math.random() * 0.3; // 0.85×–1.15×
  return Math.min(config.typingMaxMs, Math.max(700, Math.round(base * jitter)));
}

/**
 * Balas chat `jid` dengan seluruh rangkaian jeda human-like di atas.
 * `quoted` (opsional) mengutip pesan yang dibalas.
 */
export async function replyNaturally(
  sock: Socket,
  jid: string,
  text: string,
  quoted?: WAMessage,
): Promise<void> {
  // 1. Berpikir dulu — jangan pernah membalas seketika.
  await sleep(thinkingDelayMs());

  try {
    // 2–3. Mengetik, durasinya mengikuti panjang balasan.
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(typingDurationMs(text));

    // 4. Kirim pesan teksnya.
    await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
  } finally {
    // Matikan status mengetik apa pun yang terjadi.
    await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
  }
}
