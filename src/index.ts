/**
 * Bot Trainer — WhatsApp warming-up / training bot, MULTI-AKUN.
 *
 * Satu proses di satu VPS mengelola banyak akun WhatsApp sekaligus:
 * - Login tiap akun dengan PAIRING CODE saja (nomor per akun tersimpan
 *   di registry data/accounts.json). Tidak ada QR.
 * - Tiap akun: folder sesi sendiri, socket sendiri, reconnect sendiri.
 * - Akun yang selesai pairing langsung berusaha masuk grup target
 *   dari `.env`, lalu akun-akun bercakap-cakap di grup lewat
 *   orchestrator (group-chat.ts) pada jam aktif.
 *
 * Console-nya MENU BIASA (ui.ts): log semua modul tercetak langsung
 * apa adanya, dan ada satu menu bernomor sederhana:
 *   1 Tambah akun (nama → nomor → langsung pairing)
 *   2 Pairing / sambungkan akun
 *   3 Daftar akun & status
 *   4 Start / Stop sesi chat (chat-session.ts)
 *   5 Logout / hapus akun
 *   6 Keluar
 * Kode pairing tampil seketika berbingkai jelas (harus segera
 * dimasukkan ke HP akun yang di-pairing).
 */
import { createInterface } from 'node:readline';
import {
  loadOrCreateAccounts,
  nextAccountId,
  normalizePhoneNumber,
  sanitizeAccountId,
  saveAccounts,
  type AccountRecord,
} from './accounts.js';
import { BotAccount } from './bot-account.js';
import { isChatSessionRunning, startChatSession, stopChatSession } from './chat-session.js';
import { config } from './config.js';
import { ChatMemory, SerialQueue } from './handler.js';
import { GroupConversation } from './group-chat.js';
import { describeWindows, isActiveNow, startScheduler, stopScheduler } from './scheduler.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import { getAiReply } from './ai.js';
import { sleep } from './human-delay.js';
import { accountStatusLabel, printMainMenu, type AccountSnapshot } from './ui.js';

/** Tulis satu baris langsung ke stdout (untuk tampilan menu). */
function writeDirect(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Tulis prompt input apa adanya (tanpa newline di akhir). */
function writeInline(text: string): void {
  process.stdout.write(text);
}

class AccountManager {
  private readonly records = new Map<string, AccountRecord>();
  private readonly bots = new Map<string, BotAccount>();
  private readonly memory = new ChatMemory();
  private readonly queue = new SerialQueue();
  private readonly handledGroupMessages = new Set<string>();
  private readonly pairingQueue: string[] = [];
  private pairingActiveId: string | undefined;
  readonly groupChat: GroupConversation;

  constructor() {
    for (const record of loadOrCreateAccounts()) this.records.set(record.id, record);
    this.groupChat = new GroupConversation({
      eligibleBots: () => [...this.bots.values()].filter((bot) => bot.isOpen && bot.groupJid !== undefined),
      groupJid: () => config.group.jid || this.firstKnownGroupJid(),
    });
  }

  private firstKnownGroupJid(): string | undefined {
    for (const bot of this.bots.values()) if (bot.groupJid) return bot.groupJid;
    return undefined;
  }

  private persist(): void {
    saveAccounts([...this.records.values()]);
  }

  private makeBot(record: AccountRecord): BotAccount {
    const bot = new BotAccount(record.id, record.phoneNumber, this.memory, this.queue, {
      onOpen: (botAccount) => this.handleOpen(botAccount),
      onGroupMessage: (botAccount, msg, text) => void this.handleGroupMessage(botAccount, msg, text),
      onJoinedGroup: () => this.maybeHelpOthersJoin(),
      onUnavailable: (botAccount) => {
        if (this.pairingActiveId === botAccount.id) {
          this.pairingActiveId = undefined;
          this.advancePairingQueue();
        }
      },
    });
    this.bots.set(record.id, bot);
    return bot;
  }

  /**
   * Start semua akun: yang sudah punya sesi terdaftar langsung jalan
   * bersamaan (berjeda); yang belum terdaftar masuk ANTRIAN pairing —
   * kode pairing hanya diminta untuk satu akun pada satu waktu supaya
   * kode tidak tertukar. Akun tanpa nomor parkir 'needs-phone'.
   */
  async startAll(): Promise<void> {
    for (const record of this.records.values()) {
      const bot = this.makeBot(record);
      if (bot.hasRegisteredSession) {
        void bot.start();
        await sleep(1500); // jeda antar start: hindari koneksi serentak
      } else if (record.phoneNumber) {
        this.enqueuePairing(record.id);
      } else {
        bot.status = 'needs-phone';
        console.log(`[akun] Akun "${record.id}" belum punya nomor — isi lewat menu 2 (Pairing / sambungkan akun).`);
      }
    }
    this.advancePairingQueue();
    console.log(`[akun] ${this.records.size} akun dikelola: ${[...this.records.keys()].join(', ')}.`);
  }

  private enqueuePairing(accountId: string): void {
    if (this.pairingActiveId !== accountId && !this.pairingQueue.includes(accountId)) {
      this.pairingQueue.push(accountId);
    }
  }

  private advancePairingQueue(): void {
    if (this.pairingActiveId) return;
    while (this.pairingQueue.length > 0) {
      const nextId = this.pairingQueue.shift()!;
      const bot = this.bots.get(nextId);
      const record = this.records.get(nextId);
      if (!bot || !record || bot.hasRegisteredSession) continue;
      if (!record.phoneNumber) {
        bot.status = 'needs-phone';
        continue;
      }
      this.pairingActiveId = nextId;
      console.log(`[akun] Giliran pairing: "${nextId}" (+${record.phoneNumber}) — kode pairingnya akan tampil. Akun lain menunggu giliran.`);
      if (bot.status === 'stopped') void bot.start();
      else if (bot.status === 'needs-phone') void bot.restartForPairing();
      return;
    }
  }

  private handleOpen(bot: BotAccount): void {
    if (this.pairingActiveId === bot.id) {
      this.pairingActiveId = undefined;
      this.advancePairingQueue();
    }
    this.maybeHelpOthersJoin();
  }

  /** Bila akun lain belum masuk grup target, akun yang sudah di dalam mencoba menambahkannya. */
  private maybeHelpOthersJoin(): void {
    const groupJid = config.group.jid || this.firstKnownGroupJid();
    if (!groupJid) return;
    const insiders = [...this.bots.values()].filter((bot) => bot.isOpen && bot.groupJid === groupJid);
    if (insiders.length === 0) return;
    for (const outsider of this.bots.values()) {
      if (!outsider.isOpen || outsider.groupJid === groupJid) continue;
      const outsiderJid = outsider.ownJid;
      if (!outsiderJid) continue;
      void (async () => {
        for (const insider of insiders) {
          if (await insider.tryAddToGroup(groupJid, outsiderJid)) {
            console.log(`[grup] ${insider.id} menambahkan ${outsider.id} (+${outsider.connectedPhone ?? '?'}) ke grup.`);
            outsider.groupJid = groupJid;
            break;
          }
        }
      })();
    }
  }

  /**
   * Pesan MANUSIA di grup target: dedupe per id pesan (semua akun
   * menerima event yang sama), lalu SATU akun acak menjawab pada jam
   * aktif. Pesan dari akun bot diabaikan — percakapan antar-bot adalah
   * urusan orchestrator.
   */
  private async handleGroupMessage(source: BotAccount, msg: WAMessage, text: string): Promise<void> {
    const groupJid = config.group.jid || source.groupJid;
    if (!groupJid) return;
    const messageId = msg.key.id ?? `${msg.key.remoteJid}:${msg.messageTimestamp}`;
    if (this.handledGroupMessages.has(messageId)) return;
    this.handledGroupMessages.add(messageId);
    if (this.handledGroupMessages.size > 500) {
      const [oldest] = this.handledGroupMessages;
      if (oldest) this.handledGroupMessages.delete(oldest);
    }

    const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
    const botJids = new Set(
      [...this.bots.values()].map((bot) => bot.ownJid).filter((jid): jid is string => jid !== undefined),
    );
    if (botJids.has(senderJid)) return;
    if (!isChatSessionRunning() || !isActiveNow()) return;

    const candidates = [...this.bots.values()].filter(
      (bot) => bot.isOpen && bot.groupJid === groupJid && bot.ownJid !== senderJid,
    );
    if (candidates.length === 0) return;
    const responder = candidates[Math.floor(Math.random() * candidates.length)]!;

    await this.queue.run(`group:${groupJid}`, async () => {
      if (!isChatSessionRunning() || !isActiveNow() || !responder.isOpen) return;
      const historyKey = `group:${groupJid}`;
      const reply = await getAiReply(this.memory.get(historyKey), text);
      const sent = await responder.sendNaturally(groupJid, reply);
      if (sent) {
        this.memory.push(historyKey, { role: 'user', content: text });
        this.memory.push(historyKey, { role: 'assistant', content: reply });
        console.log(`[grup] ${responder.id} menjawab manusia di grup: "${reply.slice(0, 60)}"`);
      }
    });
  }

  /** Tambah akun baru (dari menu) — langsung antre pairing bila nomor valid. */
  addAccount(id: string, phoneNumber: string): BotAccount {
    const record: AccountRecord = { id, phoneNumber, createdAt: new Date().toISOString() };
    this.records.set(id, record);
    this.persist();
    const bot = this.makeBot(record);
    console.log(`[akun] Akun baru "${id}" (+${phoneNumber}) dibuat & disimpan di registry.`);
    this.enqueuePairing(id);
    this.advancePairingQueue();
    return bot;
  }

  hasAccount(id: string): boolean {
    return this.records.has(id);
  }

  suggestAccountId(): string {
    return nextAccountId([...this.records.values()]);
  }

  accountList(): BotAccount[] {
    return [...this.bots.values()];
  }

  recordOf(id: string): AccountRecord | undefined {
    return this.records.get(id);
  }

  /** Isi/ubah nomor sebuah akun lalu mulai (atau antrekan) pairing-nya. */
  setPhoneAndPair(id: string, phoneNumber: string): void {
    const record = this.records.get(id);
    const bot = this.bots.get(id);
    if (!record || !bot) return;
    record.phoneNumber = phoneNumber;
    this.persist();
    bot.setRecordPhone(phoneNumber);
    if (bot.isOpen || bot.hasRegisteredSession) {
      console.log(`[akun] Nomor "${id}" diperbarui ke +${phoneNumber} (akun sedang terhubung — nomor baru dipakai saat pairing berikutnya).`);
      return;
    }
    this.enqueuePairing(id);
    if (this.pairingActiveId === id) {
      void bot.restartForPairing(); // minta kode segar untuk nomor baru
    } else {
      this.advancePairingQueue();
    }
  }

  snapshot(): AccountSnapshot[] {
    return this.accountList().map((bot) => ({
      id: bot.id,
      status: bot.status,
      phoneNumber: bot.displayPhone,
      groupJid: bot.groupJid,
      pairingNote:
        this.pairingActiveId === bot.id
          ? 'giliran pairing'
          : this.pairingQueue.includes(bot.id)
            ? 'antre pairing'
            : undefined,
    }));
  }

  async logoutAccount(id: string, remove: boolean): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) return;
    await bot.logoutAndWipe();
    if (this.pairingActiveId === id) {
      this.pairingActiveId = undefined;
    }
    const queueIndex = this.pairingQueue.indexOf(id);
    if (queueIndex >= 0) this.pairingQueue.splice(queueIndex, 1);
    if (remove) {
      this.bots.delete(id);
      this.records.delete(id);
      this.persist();
      console.log(`[akun] Akun "${id}" di-logout, sesinya dihapus, dan dikeluarkan dari registry.`);
    } else {
      bot.status = 'needs-phone';
      console.log(`[akun] Akun "${id}" di-logout & sesinya dihapus. Pairing ulang lewat menu 2.`);
    }
    this.advancePairingQueue();
  }

  stopAll(): void {
    for (const bot of this.bots.values()) bot.stop();
  }
}

/* ─── Menu console ─────────────────────────────────────────────────── */

interface Asker {
  ask: (prompt: string) => Promise<string | null>;
  close: () => void;
}

function createAsker(): Asker {
  // Antrean baris sendiri: semua baris dari event 'line' ditampung dulu,
  // jadi input yang datang sekaligus (paste / pipa) tidak hilang dan
  // EOF hanya berarti "tidak ada lagi baris" SETELAH antrean habis —
  // bukan membatalkan pertanyaan yang sedang menunggu.
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });
  return {
    ask: (prompt) => {
      writeInline(prompt);
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

async function pickAccount(manager: AccountManager, asker: Asker, title: string): Promise<BotAccount | undefined> {
  const bots = manager.accountList();
  if (bots.length === 0) {
    writeDirect('(belum ada akun)');
    return undefined;
  }
  writeDirect(`\n${title}`);
  bots.forEach((bot, index) => {
    writeDirect(`  ${index + 1}. ${bot.id} — ${accountStatusLabel(bot.status)}${bot.displayPhone ? ` | +${bot.displayPhone}` : ''}`);
  });
  const answer = await asker.ask('Pilih nomor akun (Enter = batal): ');
  if (answer === null || answer.trim() === '') return undefined;
  const index = Number.parseInt(answer.trim(), 10) - 1;
  const bot = bots[index];
  if (!bot) writeDirect('Pilihan tidak valid.');
  return bot;
}

/**
 * Menu 1 — tambah akun. Alurnya persis tiga langkah:
 *   1) minta NAMA akun, 2) minta NOMOR HP, 3) akun dibuat dan
 *      langsung masuk proses PAIRING (antrean pairing satu-satu;
 *      kode pairing tampil berbingkai di console begitu gilirannya).
 */
async function menuAddAccount(manager: AccountManager, asker: Asker): Promise<void> {
  writeDirect('\n── Tambah akun ──');
  const nameAnswer = await asker.ask('Nama akun: ');
  if (nameAnswer === null) return;
  const id = nameAnswer.trim() === '' ? manager.suggestAccountId() : sanitizeAccountId(nameAnswer);
  if (!id) {
    writeDirect('Nama tidak valid — pakai huruf/angka/dash, maks 32 karakter. Akun tidak dibuat.');
    return;
  }
  if (manager.hasAccount(id)) {
    writeDirect(`Akun "${id}" sudah ada — pakai menu 2 untuk pairing akun itu.`);
    return;
  }
  const phoneAnswer = await asker.ask('Nomor HP: ');
  if (phoneAnswer === null) return;
  const phone = normalizePhoneNumber(phoneAnswer);
  if (!phone) {
    writeDirect('Nomor tidak valid — harus 10–15 digit (contoh: 6281234567890 / 081234567890). Akun tidak dibuat.');
    return;
  }
  manager.addAccount(id, phone);
  writeDirect(
    `✅ Akun "${id}" (+${phone}) dibuat — pairing dimulai. Kode pairingnya akan tampil di console ini (bila ada akun lain yang sedang pairing, akun ini antre dulu).`,
  );
}

async function menuPairAccount(manager: AccountManager, asker: Asker): Promise<void> {
  const bot = await pickAccount(manager, asker, 'Akun yang mau di-pairing / disambungkan:');
  if (!bot) return;
  if (bot.isOpen) {
    writeDirect(`Akun "${bot.id}" sudah terhubung (+${bot.connectedPhone ?? '?'}).`);
    return;
  }
  const record = manager.recordOf(bot.id);
  let phone = record?.phoneNumber;
  if (phone) {
    const answer = await asker.ask(`Nomor tersimpan: +${phone}. Enter = pakai nomor ini, atau ketik nomor baru: `);
    if (answer === null) return;
    if (answer.trim() !== '') {
      phone = normalizePhoneNumber(answer);
      if (!phone) {
        writeDirect('Nomor tidak valid — pairing dibatalkan.');
        return;
      }
    }
  } else {
    const answer = await asker.ask(`Akun "${bot.id}" belum punya nomor. Masukkan nomor HP (628xxxx): `);
    if (answer === null) return;
    phone = normalizePhoneNumber(answer);
    if (!phone) {
      writeDirect('Nomor tidak valid — pairing dibatalkan.');
      return;
    }
  }
  manager.setPhoneAndPair(bot.id, phone);
  writeDirect(`🔑 Pairing "${bot.id}" (+${phone}) dimulai/di-antrekan — kode pairing akan tampil di layar ini.`);
}

/** Menu 5: pilih akun, lalu pilih logout saja atau hapus akun. */
async function menuManageAccount(manager: AccountManager, asker: Asker): Promise<void> {
  const bot = await pickAccount(manager, asker, 'Kelola akun — pilih akunnya:');
  if (!bot) return;
  writeDirect(`Akun "${bot.id}" — mau diapakan?`);
  writeDirect('  1. Logout saja (sesi dihapus, akun tetap ada — pairing ulang lewat menu 2)');
  writeDirect('  2. Hapus akun (logout + sesi dihapus + keluar dari daftar akun)');
  const answer = await asker.ask('Pilih (1/2, Enter = batal): ');
  if (answer === null) return;
  if (answer.trim() === '1') {
    await manager.logoutAccount(bot.id, false);
    writeDirect(`✅ Akun "${bot.id}" sudah di-logout & sesinya dihapus.`);
  } else if (answer.trim() === '2') {
    await manager.logoutAccount(bot.id, true);
    writeDirect(`✅ Akun "${bot.id}" sudah dihapus.`);
  } else if (answer.trim() !== '') {
    writeDirect('Pilihan tidak valid — dibatalkan.');
  }
}

/**
 * Menu 4 — tombol Start/Stop sesi chat. Start menyalakan sesi
 * (orchestrator grup dibangunkan seketika lewat kick), Stop
 * mematikannya (sesi grup yang sedang jalan berhenti antar giliran,
 * balasan DM/grup langsung berhenti total).
 */
function menuToggleChatSession(manager: AccountManager): void {
  if (isChatSessionRunning()) {
    stopChatSession();
    writeDirect('⏸ Sesi chat di-STOP. Bot tetap terhubung, tapi tidak mengobrol apa pun sampai di-Start lagi.');
  } else {
    startChatSession();
    manager.groupChat.kick();
    writeDirect(
      isActiveNow()
        ? '▶ Sesi chat di-START. Percakapan grup akan dimulai sebentar lagi (butuh ≥2 akun online di grup); DM & grup mulai dijawab.'
        : '▶ Sesi chat di-START, tapi sekarang di luar jam aktif — obrolan baru jalan saat jam aktif berikutnya.',
    );
  }
}

/**
 * Loop menu utama (menu biasa 1–6). Selesai bila user memilih 6
 * (keluar) atau stdin tertutup — dalam kasus stdin tertutup bot tetap
 * hidup, hanya menunya saja yang berhenti.
 */
async function runMenu(manager: AccountManager, onExit: () => void): Promise<void> {
  const asker = createAsker();
  for (;;) {
    printMainMenu({ active: isActiveNow(), accounts: manager.snapshot(), sessionRunning: isChatSessionRunning() });
    const raw = await asker.ask('Pilih menu (1-6): ');
    if (raw === null) {
      asker.close();
      return;
    }
    const choice = raw.trim().toLowerCase();
    if (choice === '') continue; // Enter kosong = tampilkan menu lagi
    switch (choice) {
      case '1':
        await menuAddAccount(manager, asker);
        break;
      case '2':
        await menuPairAccount(manager, asker);
        break;
      case '3': {
        const bots = manager.accountList();
        writeDirect('\n── Daftar akun ──');
        if (bots.length === 0) writeDirect('(belum ada akun)');
        for (const bot of bots) {
          writeDirect(
            `• ${bot.id}: ${accountStatusLabel(bot.status)}${bot.displayPhone ? ` | +${bot.displayPhone}` : ''}${bot.groupJid ? ' | sudah di grup target' : ''}`,
          );
        }
        await asker.ask('\nEnter untuk kembali ke menu…');
        break;
      }
      case '4':
        menuToggleChatSession(manager);
        break;
      case '5':
        await menuManageAccount(manager, asker);
        break;
      case '6':
      case '0':
        writeDirect('Mematikan semua bot…');
        asker.close();
        onExit();
        return;
      default:
        writeDirect('Pilihan tidak dikenal — masukkan angka 1–6.');
        await sleep(800);
    }
  }
}

async function main(): Promise<void> {
  const active = startScheduler();
  console.log(`[jadwal] Jendela aktif: ${describeWindows()} (${config.timezone}) — status sekarang: ${active ? 'ON ☀️' : 'TIDUR 🌙'}`);
  console.log(
    config.ai.apiKey
      ? `[ai] Provider: Google Gemini (@google/genai) | model: ${config.ai.model}`
      : '[ai] GEMINI_API_KEY kosong — memakai balasan cadangan bawaan (tanpa API).',
  );
  console.log(
    config.group.jid || config.group.inviteCode
      ? `[grup] Target grup: ${config.group.jid || '(JID dari invite link)'}${config.group.inviteCode ? ' | invite: terisi' : ''}`
      : '[grup] GROUP_JID / GROUP_INVITE_CODE belum diatur — akun hanya melayani chat personal.',
  );

  const manager = new AccountManager();
  await manager.startAll();
  manager.groupChat.start();
  console.log('[sesi] Sesi chat BERHENTI — bot terhubung tapi belum mengobrol. Mulai dari menu 4 (Start sesi chat).');

  const shutdown = (): void => {
    manager.groupChat.stop();
    manager.stopAll();
    stopScheduler();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runMenu(manager, shutdown);
}

void main();
