import type { makeWASocket, WAMessage } from '@whiskeysockets/baileys';
import { getAiReply, type ChatTurn } from './ai.js';
import { config } from './config.js';
import { replyNaturally } from './human-delay.js';
import { isActiveNow } from './scheduler.js';

/**
 * Handler pesan masuk.
 *
 * Aturan main bot trainer — semuanya demi pola aktivitas yang natural:
 * - HANYA membalas. Bot tidak pernah memulai chat, mengirim broadcast,
 *   atau menyapa duluan ke siapa pun.
 * - Di luar jam aktif (mode tidur) pesan diabaikan total:
 *   tidak dibaca, tidak dibalas, tidak ada presence.
 * - Default hanya chat personal 1-on-1; grup diabaikan kecuali
 *   RESPOND_TO_GROUPS=true.
 * - Balasan per chat diproses berurutan (antrean per chat), jadi bot
 *   tidak pernah mengirim dua balasan tumpang tindih di chat yang sama.
 * - Konteks 6 giliran terakhir per chat disimpan di memori supaya
 *   obrolan nyambung; hilang saat proses restart (memang disengaja).
 */

type Socket = ReturnType<typeof makeWASocket>;

const MAX_HISTORY_TURNS = 6;

const histories = new Map<string, ChatTurn[]>();
const queues = new Map<string, Promise<void>>();

/** Ambil teks dari pesan: chat biasa, extended text, atau caption media. */
export function extractText(msg: WAMessage): string | undefined {
  const message = msg.message;
  if (!message) return undefined;
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    undefined;
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function pushHistory(jid: string, turn: ChatTurn): void {
  const history = histories.get(jid) ?? [];
  history.push(turn);
  while (history.length > MAX_HISTORY_TURNS * 2) history.shift();
  histories.set(jid, history);
}

async function processMessage(sock: Socket, msg: WAMessage, jid: string, text: string): Promise<void> {
  // Cek ulang jam aktif tepat sebelum bekerja: pesan yang masuk di detik
  // terakhir jam aktif tidak boleh dibalas setelah bot masuk jam tidur.
  if (!isActiveNow()) {
    console.log(`[tidur] Pesan dari ${jid} diabaikan — bot di luar jam aktif.`);
    return;
  }

  if (config.markAsRead) {
    await sock.readMessages([msg.key]).catch(() => undefined);
  }

  const history = histories.get(jid) ?? [];
  const reply = await getAiReply(history, text);

  await replyNaturally(sock, jid, reply, msg);

  pushHistory(jid, { role: 'user', content: text });
  pushHistory(jid, { role: 'assistant', content: reply });
  console.log(`[chat] ${jid} <- "${text.slice(0, 60)}" | -> "${reply.slice(0, 60)}"`);
}

/**
 * Titik masuk untuk setiap pesan dari event `messages.upsert`.
 * Penyaringan (punya sendiri / status / grup / jam tidur) terjadi di
 * sini; pekerjaan beratnya masuk antrean per chat.
 */
export async function handleIncomingMessage(sock: Socket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (jid === 'status@broadcast') return;

  // Mode tidur: abaikan sepenuhnya, persis seperti HP yang ditinggal tidur.
  if (!isActiveNow()) return;

  if (jid.endsWith('@g.us') && !config.respondToGroups) return;

  const text = extractText(msg);
  if (!text) return; // text-only: stiker/media tanpa caption diabaikan

  const previous = queues.get(jid) ?? Promise.resolve();
  const run = previous
    .then(() => processMessage(sock, msg, jid, text))
    .catch((err: unknown) => {
      console.error(`[chat] Gagal memproses pesan dari ${jid}:`, err);
    });
  queues.set(jid, run);
  await run;
}
