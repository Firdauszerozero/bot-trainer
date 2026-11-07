/**
 * Bot Trainer — WhatsApp warming-up / training bot (Baileys, TypeScript)
 *
 * Tujuan: menjaga pola aktivitas akun tetap natural seperti pemakaian
 * manusia biasa.
 * - Login PERTAMA dengan pairing code (nomor HP) — QR tidak pernah dipakai.
 * - Sesi tersimpan lokal di AUTH_DIR dan dipakai ulang otomatis.
 * - Hanya aktif membalas pada jam aktif (lihat scheduler.ts); di luar itu
 *   bot tidur dan mengabaikan pesan masuk.
 * - Balasan selalu lewat jeda human-like (lihat human-delay.ts) dan
 *   dihasilkan AI text-only bergaya chat santai (lihat ai.ts).
 * - Bot HANYA membalas chat yang masuk. Tidak ada pengiriman proaktif,
 *   broadcast, atau auto-chat ke nomor mana pun di kode ini.
 */
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import pino from 'pino';
import { createInterface } from 'node:readline';
import { config } from './config.js';
import { handleIncomingMessage } from './handler.js';
import { sleep } from './human-delay.js';
import { describeWindows, startScheduler, stopScheduler } from './scheduler.js';
import { ensureUsableSession, wipeSession } from './session.js';

type Socket = ReturnType<typeof makeWASocket>;

// Bila environment menyediakan HTTP(S) proxy, WebSocket WhatsApp harus
// memakainya juga — koneksi wss langsung gagal di sandbox/VPS berproxy.
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

let currentSock: Socket | undefined;
let pairingRequested = false;
let connecting = false;
let shuttingDown = false;
let sessionChecked = false;
let consecutiveLogouts = 0;

function printPairingCode(code: string): void {
  const line = '═'.repeat(44);
  console.log(`\n╔${line}╗`);
  console.log(`   🔑  KODE PAIRING WHATSAPP:  ${code}`);
  console.log(`   📱  Nomor: +${config.phoneNumber}`);
  console.log('   Masukkan di: WhatsApp → Perangkat tertaut →');
  console.log('   Tautkan perangkat → "Tautkan dengan nomor telepon"');
  console.log(`╚${line}╝\n`);
}

async function requestPairing(sock: Socket): Promise<void> {
  if (pairingRequested || sock.authState.creds.registered) return;
  if (!config.phoneNumber) {
    console.error(
      '[auth] BOT_PHONE_NUMBER belum diisi di .env — pairing code tidak bisa diminta. ' +
        'Isi nomor (format 628xxxx) lalu jalankan ulang.',
    );
    return;
  }
  pairingRequested = true;
  // Socket butuh waktu menyelesaikan handshake awal dulu.
  await sleep(3000);
  if (sock.authState.creds.registered) return;
  try {
    console.log(`[auth] Sesi kosong — meminta kode pairing untuk +${config.phoneNumber}…`);
    const code = await sock.requestPairingCode(config.phoneNumber);
    printPairingCode(code);
  } catch (err) {
    pairingRequested = false; // izinkan percobaan ulang pada reconnect berikut
    console.error('[auth] Gagal meminta kode pairing:', err);
    console.error('[auth] Pastikan BOT_PHONE_NUMBER benar (format 628xxxx) dan nomor itu aktif di WhatsApp.');
  }
}

async function connect(): Promise<void> {
  if (connecting) return;
  connecting = true;
  try {
    // Sekali per proses: pakai ulang sesi TERDAFTAR apa adanya; hapus sisa
    // sesi yang tidak pernah selesai pairing supaya tidak meracuni start.
    if (!sessionChecked) {
      sessionChecked = true;
      if (ensureUsableSession(config.authDir)) {
        console.log('[sesi] Sesi terdaftar ditemukan — memakai sesi tersimpan, tidak perlu login ulang. (Ketik .logout di console untuk keluar & menghapus sesi.)');
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: config.logLevel }),
      // Pairing-code only: QR tidak pernah dirender / dipakai.
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      agent,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    currentSock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Sesi kosong -> minta pairing code. Mana pun reconnect yang terjadi
    // sebelum pairing selesai akan meminta kode BARU (kode lama hangus).
    if (!sock.authState.creds.registered) {
      void requestPairing(sock);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        consecutiveLogouts = 0;
        console.log(`[bot] ✅ Terhubung sebagai +${sock.user?.id?.split(':')[0] ?? config.phoneNumber}.`);
      }
      if (connection === 'close') {
        if (shuttingDown) return; // .logout sedang berjalan — jangan ikut campur
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        try {
          sock.end(undefined);
        } catch {
          /* sudah tertutup */
        }
        connecting = false;
        // Ditutup sebelum sempat terdaftar (mis. kode pairing hangus tak
        // terpakai): izinkan koneksi berikut meminta kode SEGAR.
        if (!sock.authState.creds.registered) pairingRequested = false;

        if (statusCode === DisconnectReason.loggedOut) {
          // Sesi mati (perangkat dilepas dari HP, atau sisa setengah
          // pairing). Hapus otomatis dan tawarkan pairing ulang.
          // Pengaman: 2× berturut-turut = berhenti, jangan loop.
          consecutiveLogouts += 1;
          wipeSession(config.authDir);
          pairingRequested = false;
          if (consecutiveLogouts >= 2) {
            console.error('[koneksi] Sesi ditolak WhatsApp berulang kali (401). Sesi sudah dihapus; bot berhenti. Jalankan ulang untuk pairing dari awal.');
            return;
          }
          console.error('[koneksi] Sesi logout/ditolak (401) — sesi lama dihapus otomatis. Pairing ulang 3 detik lagi…');
          setTimeout(() => {
            void connect();
          }, 3000);
          return;
        }

        // 515 (restartRequired) itu normal tepat setelah pairing — sambung
        // ulang segera. Putus biasa: tunggu 5 detik (pola reconnect wajar).
        const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
        console.log(`[koneksi] Terputus (kode ${statusCode ?? '?'}). Sambung ulang ${delay / 1000} detik…`);
        setTimeout(() => {
          void connect();
        }, delay);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        // Sengaja tidak di-await satu per satu: antrean per chat di
        // handler menjaga urutan di dalam satu chat, sementara chat
        // lain tidak ikut tersendat.
        void handleIncomingMessage(sock, msg);
      }
    });
  } catch (err) {
    connecting = false;
    console.error('[bot] Gagal inisialisasi, coba lagi 10 detik…', err);
    setTimeout(() => {
      void connect();
    }, 10_000);
  }
}

/**
 * Perintah console: ketik `.logout` di terminal bot untuk disconnect
 * dengan bersih — perangkat dilepas di sisi WhatsApp, sesi lokal
 * dihapus, proses berhenti. Start berikutnya pairing dari awal.
 */
async function doLogout(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[logout] Memutus koneksi WhatsApp & menghapus sesi…');
  try {
    if (currentSock) {
      await Promise.race([
        currentSock.logout().catch(() => undefined),
        sleep(8000),
      ]);
      try {
        currentSock.end(undefined);
      } catch {
        /* sudah tertutup */
      }
    }
  } catch (err) {
    console.warn('[logout] Ada kendala saat logout, sesi lokal tetap dihapus:', err);
  }
  wipeSession(config.authDir);
  console.log('[logout] ✅ Sesi terhapus. Bot berhenti — jalankan ulang untuk pairing baru.');
  process.exit(0);
}

function startConsoleCommands(): void {
  try {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === '.logout' || cmd === 'logout') {
        void doLogout();
      }
    });
  } catch {
    /* stdin tidak tersedia di sebagian host — perintah console nonaktif */
  }
}

async function main(): Promise<void> {
  const active = startScheduler();
  console.log(`[jadwal] Jendela aktif: ${describeWindows()} (${config.timezone}) — status sekarang: ${active ? 'ON ☀️' : 'TIDUR 🌙'}`);
  console.log(
    config.ai.apiKey
      ? `[ai] Provider: ${config.ai.baseURL} | model: ${config.ai.model}`
      : '[ai] AI_API_KEY kosong — memakai balasan cadangan bawaan (tanpa API).',
  );
  if (agent) console.log('[bot] Memakai proxy environment untuk koneksi WhatsApp.');
  startConsoleCommands();
  await connect();
}

process.on('SIGINT', () => {
  stopScheduler();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopScheduler();
  process.exit(0);
});

void main();
