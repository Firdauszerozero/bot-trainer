import type { WAMessage } from '@whiskeysockets/baileys';
import type { ChatTurn } from './ai.js';

/**
 * Utilitas percakapan bersama untuk semua akun:
 * - extractText: ambil teks dari pesan masuk (chat biasa / extended /
 *   caption media). Text-only — stiker & media tanpa caption diabaikan.
 * - ChatMemory: konteks N giliran terakhir per (akun, chat), disimpan di
 *   memori proses saja. Sengaja hilang saat restart.
 * - SerialQueue: antrean berurutan per kunci, supaya satu chat tidak
 *   pernah dibalas dua kali tumpang tindih oleh akun yang sama.
 */

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

export class ChatMemory {
  private readonly histories = new Map<string, ChatTurn[]>();

  constructor(private readonly maxTurns = 6) {}

  get(key: string): readonly ChatTurn[] {
    return this.histories.get(key) ?? [];
  }

  push(key: string, turn: ChatTurn): void {
    const history = [...(this.histories.get(key) ?? []), turn];
    while (history.length > this.maxTurns * 2) history.shift();
    this.histories.set(key, history);
  }
}

export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Jalankan `task` setelah tugas sebelumnya untuk `key` yang sama selesai. */
  async run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(task, task).catch((err: unknown) => {
      console.error(`[queue:${key}]`, err);
    });
    this.tails.set(key, current);
    await current;
  }
}
