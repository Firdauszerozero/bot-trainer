import { config } from './config.js';
import type { BotAccount } from './bot-account.js';
import { randomIntInclusive, sleep } from './human-delay.js';
import { isActiveNow } from './scheduler.js';

/**
 * Orkestrasi percakapan antar-bot di dalam grup target.
 *
 * Kenapa digerakkan dari sini (bukan dari event pesan masuk)?
 * Setiap akun bot menerima event untuk pesan yang sama, dan pesan bot
 * sendiri juga muncul sebagai event. Membalas lewat event akan membuat
 * semua bot menjawab serentak dan bot-membalas-bot tanpa henti.
 * Orchestrator ini yang mengatur giliran secara terpusat:
 *
 * - Sesi percakapan hanya mulai pada jam aktif, dengan jeda acak
 *   GROUP_CHAT_INTERVAL_MIN/MAX_MINUTES antar sesi.
 * - Satu sesi = GROUP_CHAT_MIN/MAX_TURNS giliran bicara, bergantian
 *   antar 2–4 akun yang sedang online & sudah di dalam grup
 *   (akun yang sama tidak bicara dua kali berturut-turut).
 * - Setiap giliran: teks digenerate AI dari konteks obrolan terakhir,
 *   dikirim akun tersebut dengan jeda human-like penuh
 *   (berpikir → composing → mengetik → kirim) lewat sendNaturally().
 * - Di luar jam aktif / peserta < 2: sesi dilewati, dicoba lagi nanti.
 *
 * Topik pembuka dipilih acak dari daftar topik santai di bawah.
 */

const TOPICS: readonly string[] = [
  'rencana weekend ini',
  'film atau series yang lagi seru',
  'makanan enak yang terakhir dicoba',
  'musik yang lagi sering didengerin',
  'kerjaan atau kuliah hari ini',
  'game yang lagi dimainkan',
  'cuaca akhir-akhir ini',
  'kopi atau teh, tim mana',
  'tempat nongkrong yang enak',
  'hobi yang lagi ditekuni',
  'berita bola semalam',
  'rencana liburan hemat',
];

export interface GroupChatDeps {
  /** Semua akun yang saat ini online DAN sudah berada di grup target. */
  eligibleBots: () => BotAccount[];
  groupJid: () => string | undefined;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Pilih pembicara berikutnya: acak, tapi bukan pembicara terakhir. */
export function pickNextSpeaker<T extends { id: string }>(bots: readonly T[], lastId?: string): T | undefined {
  const candidates = bots.filter((bot) => bot.id !== lastId);
  if (candidates.length === 0) return bots[0];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export class GroupConversation {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private sessionInProgress = false;
  private lastTopic: string | undefined;

  constructor(private readonly deps: GroupChatDeps) {}

  start(): void {
    if (!config.group.chatEnabled) {
      console.log('[grup] Percakapan antar-bot nonaktif (GROUP_CHAT_ENABLED=false).');
      return;
    }
    this.running = true;
    this.scheduleNext(randomIntInclusive(1, 3) * 60_000); // sesi pertama tidak lama setelah start
    console.log(
      `[grup] Percakapan antar-bot aktif: jeda antar sesi ${config.group.chatIntervalMinMinutes}–${config.group.chatIntervalMaxMinutes} menit, ` +
        `${config.group.chatMinTurns}–${config.group.chatMaxTurns} giliran per sesi (hanya pada jam aktif, butuh ≥2 akun di grup).`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private nextIntervalMs(): number {
    return (
      randomIntInclusive(config.group.chatIntervalMinMinutes, config.group.chatIntervalMaxMinutes) * 60_000
    );
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runSession();
    } catch (err) {
      console.error('[grup] Sesi percakapan gagal:', err);
    }
    this.scheduleNext(this.nextIntervalMs());
  }

  /** Jalankan satu sesi percakapan (dipakai timer; public untuk pengujian manual). */
  async runSession(): Promise<boolean> {
    if (this.sessionInProgress) return false;
    const groupJid = this.deps.groupJid();
    if (!groupJid) return false;
    if (!isActiveNow()) {
      console.log('[grup] Sesi dilewati — di luar jam aktif (bot tidur).');
      return false;
    }
    const bots = this.deps.eligibleBots().filter((bot) => bot.groupJid === groupJid && bot.isOpen);
    if (bots.length < 2) {
      console.log(`[grup] Sesi dilewati — baru ${bots.length} akun online di grup (butuh ≥2).`);
      return false;
    }

    this.sessionInProgress = true;
    try {
      const participants = shuffled(bots).slice(0, Math.min(bots.length, 4));
      const turns = randomIntInclusive(config.group.chatMinTurns, config.group.chatMaxTurns);
      const topic = this.pickTopic();
      console.log(
        `[grup] 🗣️  Sesi percakapan baru — topik "${topic}", ${turns} giliran, peserta: ${participants.map((bot) => bot.id).join(', ')}.`,
      );

      const historyKey = `group:${groupJid}`;
      let lastSpeakerId: string | undefined;
      let lastLine = '';

      for (let turn = 0; turn < turns; turn += 1) {
        if (!this.running || !isActiveNow()) {
          console.log('[grup] Sesi dihentikan di tengah — bot masuk jam tidur / berhenti.');
          break;
        }
        const speaker = pickNextSpeaker(participants, lastSpeakerId);
        if (!speaker) break;

        const prompt =
          turn === 0
            ? `(buka obrolan santai di grup whatsapp sama temen-temen soal ${topic}. ` +
              `ngomong kayak chat biasa, satu-dua kalimat pendek aja, jangan kelihatan kayak pembuka formal. nama panggilanmu di grup: ${speaker.id})`
            : `(${lastSpeakerId} barusan bilang: "${lastLine}". ` +
              `balas santai kayak temen grup whatsapp, nyambung sama omongan terakhir, jangan ngulang topik dari awal. nama panggilanmu di grup: ${speaker.id})`;

        const line = await speaker.generateReply(historyKey, prompt);
        const sent = await speaker.sendNaturally(groupJid, line);
        if (!sent) {
          console.log(`[grup] Giliran ${speaker.id} dilewati — akun tidak lagi terhubung.`);
          continue;
        }
        console.log(`[grup] ${speaker.id}: ${line}`);
        lastSpeakerId = speaker.id;
        lastLine = line;

        if (turn < turns - 1) {
          await sleep(randomIntInclusive(config.group.chatTurnGapMinMs, config.group.chatTurnGapMaxMs));
        }
      }
      console.log('[grup] Sesi percakapan selesai.');
      return true;
    } finally {
      this.sessionInProgress = false;
    }
  }

  private pickTopic(): string {
    const candidates = TOPICS.filter((topic) => topic !== this.lastTopic);
    const topic = candidates[Math.floor(Math.random() * candidates.length)] ?? TOPICS[0]!;
    this.lastTopic = topic;
    return topic;
  }
}
