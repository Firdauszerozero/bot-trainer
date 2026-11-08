import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import pino from 'pino';
import { authDirFor } from './accounts.js';
import { getAiReply } from './ai.js';
import { config } from './config.js';
import { ChatMemory, SerialQueue, extractText } from './handler.js';
import { replyNaturally, sleep } from './human-delay.js';
import { isActiveNow } from './scheduler.js';
import { ensureUsableSession, isRegisteredSession, wipeSession } from './session.js';

import { showPairingCode } from './ui.js';

export type BotAccountStatus =
  | 'stopped'
  | 'connecting'
  | 'waiting-pairing'
  | 'needs-phone'
  | 'open'
  | 'reconnecting';

export interface BotAccountEvents {
  /** Socket terhubung (sesi terdaftar dipakai / pairing QR selesai). */
  onOpen: (bot: BotAccount) => void;
  /** Pesan grup diterima akun ini (diteruskan ke manager untuk dedupe & pemilihan penjawab). */
  onGroupMessage: (bot: BotAccount, msg: WAMessage, text: string) => void;
  /** Akun ini sudah di dalam grup target (atau baru berhasil masuk). */
  onJoinedGroup: (bot: BotAccount, groupJid: string) => void;
  /** Akun ini berhenti permanen (401 berulang) — bebaskan antrean pairing. */
  onUnavailable: (bot: BotAccount) => void;
}

const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

/**
 * Satu akun WhatsApp = satu BotAccount = satu socket Baileys + satu
 * folder sesi sendiri. Banyak BotAccount hidup berdampingan dalam satu
 * proses (satu VPS) dan dikelola AccountManager di index.ts.
 *
 * Login: PAIRING CODE SAJA. Tidak ada QR di alur ini — sesi kosong
 * meminta kode pairing untuk nomor HP akun (dari registry) dan
 * menampilkannya berlabel id akun lewat UI console.
 */
export class BotAccount {
  readonly id: string;
  readonly authDir: string;
  status: BotAccountStatus = 'stopped';
  /** JID grup target yang sudah berhasil dimasuki akun ini. */
  groupJid: string | undefined;

  private sock: ReturnType<typeof makeWASocket> | undefined;
  private connecting = false;
  private stopped = true;
  private consecutiveLogouts = 0;
  private groupJoinAttempted = false;

  constructor(
    id: string,
    /** Nomor HP dari registry — dipakai meminta pairing code. */
    public recordPhone: string | undefined,
    private readonly memory: ChatMemory,
    private readonly queue: SerialQueue,
    private readonly events: BotAccountEvents,
  ) {
    this.id = id;
    this.authDir = authDirFor(id);
  }

  setRecordPhone(phone: string | undefined): void {
    this.recordPhone = phone;
  }

  /** Nomor HP akun ini (digit) bila sudah terhubung, dari sesi socket. */
  get connectedPhone(): string | undefined {
    const raw = this.sock?.user?.id?.split(':')[0];
    return raw && /^\d+$/.test(raw) ? raw : undefined;
  }

  /** Nomor terbaik untuk ditampilkan: dari sesi bila terhubung, else dari registry. */
  get displayPhone(): string | undefined {
    return this.connectedPhone ?? this.recordPhone;
  }

  /** JID personal akun ini, mis. "62812xxxx@s.whatsapp.net". */
  get ownJid(): string | undefined {
    const phone = this.connectedPhone;
    return phone ? `${phone}@s.whatsapp.net` : undefined;
  }

  get isOpen(): boolean {
    return this.status === 'open' && this.sock !== undefined;
  }

  get hasRegisteredSession(): boolean {
    return isRegisteredSession(this.authDir);
  }

  private log(message: string): void {
    console.log(`[${this.id}] ${message}`);
  }

  private sessionChecked = false;
  private pairingRequested = false;

  /**
   * Minta pairing code untuk nomor registry akun ini dan tampilkan
   * lewat UI (langsung terlihat, tidak menunggu refresh dashboard).
   * Tanpa nomor, akun parkir di status 'needs-phone' sampai nomor
   * diisi lewat menu console.
   */
  private async requestPairing(sock: ReturnType<typeof makeWASocket>): Promise<void> {
    if (this.pairingRequested || sock.authState.creds.registered) return;
    if (!this.recordPhone) {
      this.status = 'needs-phone';
      this.log('📱 Belum ada nomor HP — isi lewat menu "Pairing / sambungkan akun" untuk menerima kode pairing.');
      return;
    }
    this.pairingRequested = true;
    this.status = 'waiting-pairing';
    await sleep(3000); // socket butuh menyelesaikan handshake awal dulu
    if (this.stopped || sock.authState.creds.registered) return;
    try {
      const code = await sock.requestPairingCode(this.recordPhone);
      showPairingCode(this.id, this.recordPhone, code);
    } catch (err) {
      this.pairingRequested = false; // izinkan percobaan ulang pada reconnect berikut
      console.error(`[${this.id}] Gagal meminta kode pairing:`, err);
      this.log('Pastikan nomor benar (format 628xxxx) dan aktif di WhatsApp.');
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.sessionChecked) {
      this.sessionChecked = true;
      // Sisa sesi setengah-pairing dibersihkan sebelum socket pertama;
      // sesi TERDAFTAR selalu dipakai ulang apa adanya.
      ensureUsableSession(this.authDir);
    }
    await this.connect();
  }

  /** Restart socket akun ini (dipakai setelah nomor pairing diisi/diubah). */
  async restartForPairing(): Promise<void> {
    this.stop();
    this.pairingRequested = false;
    await this.start();
  }

  /** Hentikan socket akun ini saja (akun lain tidak terganggu). */
  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    try {
      this.sock?.end(undefined);
    } catch {
      /* sudah tertutup */
    }
    this.sock = undefined;
  }

  /** Logout di sisi WhatsApp + hapus sesi lokal akun ini. */
  async logoutAndWipe(): Promise<void> {
    const sock = this.sock;
    this.stop();
    if (sock) {
      await Promise.race([sock.logout().catch(() => undefined), sleep(8000)]);
    }
    wipeSession(this.authDir);
    this.groupJoinAttempted = false;
    this.groupJid = undefined;
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    this.status = this.status === 'open' ? 'open' : 'connecting';
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: config.logLevel }),
        printQRInTerminal: false, // QR tidak dipakai sama sekali di bot ini
        browser: Browsers.ubuntu('Chrome'),
        agent,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);

      // Sesi kosong -> minta pairing code untuk nomor registry akun ini.
      if (!sock.authState.creds.registered) {
        void this.requestPairing(sock);
      }

      sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          this.status = 'open';
          this.consecutiveLogouts = 0;
          this.log(`✅ Terhubung sebagai +${this.connectedPhone ?? '?'}.`);
          void this.ensureGroupMembership();
          this.events.onOpen(this);
        }
        if (connection === 'close') {
          if (this.stopped) return;
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
            ?.output?.statusCode;
          try {
            sock.end(undefined);
          } catch {
            /* sudah tertutup */
          }
          this.connecting = false;
          this.status = 'reconnecting';
          // Ditutup sebelum sempat terdaftar (kode pairing hangus tak
          // terpakai): izinkan koneksi berikut meminta kode SEGAR.
          if (!sock.authState.creds.registered) this.pairingRequested = false;

          if (statusCode === DisconnectReason.loggedOut) {
            this.consecutiveLogouts += 1;
            wipeSession(this.authDir);
            this.groupJoinAttempted = false;
            this.groupJid = undefined;
            if (this.consecutiveLogouts >= 2) {
              this.log('Sesi ditolak WhatsApp berulang kali (401). Sesi dihapus; akun ini berhenti — pakai menu "Pairing / sambungkan akun" untuk mencoba lagi.');
              this.status = 'stopped';
              this.stopped = true;
              this.events.onUnavailable(this);
              return;
            }
            this.log('Sesi logout/ditolak (401) — sesi lama dihapus otomatis. Kode pairing baru 3 detik lagi…');
            setTimeout(() => void this.connect(), 3000);
            return;
          }

          const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
          this.log(`Terputus (kode ${statusCode ?? '?'}). Sambung ulang ${delay / 1000} detik…`);
          setTimeout(() => void this.connect(), delay);
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          void this.handleUpsert(msg);
        }
      });
    } catch (err) {
      this.connecting = false;
      this.status = 'reconnecting';
      console.error(`[${this.id}] Gagal inisialisasi, coba lagi 10 detik…`, err);
      setTimeout(() => void this.connect(), 10_000);
    }
  }

  private async handleUpsert(msg: WAMessage): Promise<void> {
    const sock = this.sock;
    if (!sock) return;
    const jid = msg.key.remoteJid;
    if (!jid || msg.key.fromMe) return;
    if (jid === 'status@broadcast') return;

    const text = extractText(msg);
    if (!text) return;

    // Grup target: semua akun menerima pesan yang sama, jadi JANGAN
    // dijawab di sini — manager yang dedupe & memilih SATU akun penjawab
    // (dan percakapan antar-bot digerakkan orchestrator, bukan event ini,
    // supaya tidak ada loop bot-membalas-bot tanpa batas).
    if (config.group.jid && jid === config.group.jid) {
      this.events.onGroupMessage(this, msg, text);
      return;
    }
    // Grup lain: abaikan kecuali RESPOND_TO_GROUPS=true (di luar grup
    // target pun hanya akun penerima langsung yang menjawab).
    if (jid.endsWith('@g.us') && !config.respondToGroups) return;
    if (jid.endsWith('@g.us') && config.group.jid && jid !== config.group.jid && !config.respondToGroups) return;

    // Chat personal (atau grup non-target bila diizinkan): balas
    // hanya saat jam aktif, dengan rangkaian jeda human-like.
    if (!isActiveNow()) return;
    const senderKey = `${this.id}:${jid}`;
    await this.queue.run(senderKey, async () => {
      if (!isActiveNow()) return;
      if (config.markAsRead) await sock.readMessages([msg.key]).catch(() => undefined);
      const reply = await getAiReply(this.memory.get(senderKey), text);
      await replyNaturally(sock, jid, reply, msg);
      this.memory.push(senderKey, { role: 'user', content: text });
      this.memory.push(senderKey, { role: 'assistant', content: reply });
      this.log(`💬 ${jid} <- "${text.slice(0, 50)}" | -> "${reply.slice(0, 50)}"`);
    });
  }

  /** Kirim teks ke sebuah JID dengan jeda human-like penuh (dipakai percakapan grup). */
  async sendNaturally(jid: string, text: string): Promise<boolean> {
    if (!this.sock || !this.isOpen) return false;
    await replyNaturally(this.sock, jid, text);
    return true;
  }

  /** Hasilkan satu balasan AI dengan konteks `historyKey`, lalu catat ke memori. */
  async generateReply(historyKey: string, prompt: string): Promise<string> {
    const reply = await getAiReply(this.memory.get(historyKey), prompt);
    this.memory.push(historyKey, { role: 'user', content: prompt });
    this.memory.push(historyKey, { role: 'assistant', content: reply });
    return reply;
  }

  /** JID semua grup yang sudah diikuti akun ini (untuk menemukan grup dari invite link). */
  async isInGroup(groupJid: string): Promise<boolean> {
    if (!this.sock || !this.isOpen) return false;
    try {
      const meta = await this.sock.groupMetadata(groupJid);
      const own = this.ownJid;
      const ownLid = this.sock.user?.lid;
      return meta.participants.some(
        (participant) =>
          participant.id === own ||
          (ownLid !== undefined && (participant as { lid?: string }).lid === ownLid),
      );
    } catch {
      return false;
    }
  }

  /**
   * Pastikan akun ini masuk grup target setelah terhubung:
   * 1. Sudah jadi peserta -> selesai (catat & kabari manager).
   * 2. Ada GROUP_INVITE_CODE/LINK -> gabung sendiri via groupAcceptInvite.
   * 3. Hanya ada GROUP_JID -> minta akun lain yang sudah di dalam grup
   *    untuk menambahkan nomor ini (dikoordinasikan manager lewat
   *    tryAddToGroup di bawah; penambah harus admin bila grup tertutup).
   * 4. Tidak ada keduanya -> log petunjuk; akun tetap jalan untuk DM.
   */
  async ensureGroupMembership(): Promise<void> {
    if (this.groupJoinAttempted) return;
    this.groupJoinAttempted = true;

    const targetJid = config.group.jid;
    try {
      if (targetJid && (await this.isInGroup(targetJid))) {
        this.groupJid = targetJid;
        this.log(`👥 Sudah berada di grup target ${targetJid}.`);
        this.events.onJoinedGroup(this, targetJid);
        return;
      }

      if (config.group.inviteCode && this.sock) {
        this.log('👥 Mencoba gabung grup lewat invite link/kode dari .env…');
        const joinedJid = await this.sock.groupAcceptInvite(config.group.inviteCode);
        const jid = joinedJid ?? targetJid;
        if (jid) {
          this.groupJid = jid;
          if (!targetJid) {
            this.log(`👥 Berhasil gabung grup ${jid}. (Isi GROUP_JID=${jid} di .env agar percakapan grup terarah ke grup ini.)`);
          } else {
            this.log(`👥 Berhasil gabung grup ${jid}.`);
          }
          this.events.onJoinedGroup(this, jid);
          return;
        }
      }

      if (targetJid) {
        this.log(
          `👥 Belum di grup ${targetJid} dan tidak ada invite code yang berhasil — menunggu ditambahkan akun lain/admin. ` +
            'Cara tercepat: isi GROUP_INVITE_CODE atau GROUP_INVITE_LINK di .env, atau tambahkan nomor ini ke grup secara manual.',
        );
        return;
      }

      this.log('👥 GROUP_JID & invite belum diatur di .env — akun berjalan untuk chat personal saja.');
    } catch (err) {
      // groupAcceptInvite melempar error bila sudah jadi anggota dsb.
      if (targetJid && (await this.isInGroup(targetJid))) {
        this.groupJid = targetJid;
        this.events.onJoinedGroup(this, targetJid);
        return;
      }
      this.log(`👥 Gagal gabung grup otomatis: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Tambahkan nomor lain ke grup target lewat akun ini (harus peserta; admin bila grup membatasi). */
  async tryAddToGroup(groupJid: string, participantJid: string): Promise<boolean> {
    if (!this.sock || !this.isOpen) return false;
    try {
      const result = await this.sock.groupParticipantsUpdate(groupJid, [participantJid], 'add');
      const status = result?.[0]?.status;
      return status === undefined || status === '200' || status === '409'; // 409 = sudah peserta
    } catch {
      return false;
    }
  }
}
