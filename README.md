# Bot Trainer — WhatsApp Warming-Up Bot, Multi-Akun (TypeScript)

Bot WhatsApp untuk **warming up / training banyak akun sekaligus dalam satu proses di satu VPS**. Dibangun di atas [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) (TypeScript, ESM) dengan balasan AI text-only dari **Google Gemini 2.5 Flash** (SDK resmi `@google/genai`) bergaya chat santai anak muda Indonesia.

Semua akun bot **bercakap-cakap di dalam satu grup WhatsApp target**: akun yang baru selesai pairing langsung berusaha masuk grup itu, lalu orchestrator mengatur sesi obrolan antar-bot secara bergiliran — hanya pada jam aktif, dengan jeda human-like penuh.

> ⚠️ **Peringatan ban (jujur, bukan basa-basi):** Baileys adalah klien **tidak resmi**. Pola human-like mengurangi perilaku yang mencolok sebagai bot, tetapi **tidak ada cara yang menjamin 100% bebas ban** — dan menjalankan banyak akun dari satu VPS / satu IP justru menambah permukaan risiko (pola bersama lebih mudah dikenali daripada satu akun rumahan). Gunakan **nomor cadangan** yang sudah berumur & terpakai normal, jaga volume wajar, dan jangan jadikan grup bot ini grup publik.

---

## Cara Kerja

1. **Login pairing code saja** — tidak ada QR. Nomor HP tiap akun dimasukkan lewat menu console dan tersimpan di registry; akun yang belum punya sesi menerima **kode pairing berlabel id akun** yang tampil langsung di dashboard untuk dimasukkan di HP akun tersebut (WhatsApp → Perangkat tertaut → Tautkan perangkat → "Tautkan dengan nomor telepon").
2. **Multi-akun dalam satu proses** — tiap akun punya folder sesi sendiri (`auth_info/<id>/`), socket sendiri, dan reconnect sendiri. Satu akun putus tidak mengganggu akun lain.
3. **Antrean pairing** — akun yang sudah terdaftar langsung jalan bersamaan, tetapi kode pairing hanya diminta untuk **satu akun pada satu waktu** (antrean) supaya kode tidak tertukar antar akun. Setelah satu akun selesai pairing, giliran akun antrean berikutnya otomatis.
4. **UI menu console** — saat proses hidup, console menampilkan satu **dashboard**: status bot (aktif/tidur), jadwal, AI, grup, daftar akun + statusnya, log chat terakhir, dan log sistem terakhir, plus menu bernomor. Semua log modul ditangkap ke dashboard (tidak mengotori layar); hanya kode pairing yang tampil seketika. Tambah akun dari menu **1**, pairing akun yang belum terhubung dari menu **2**. Akun tercatat di `data/accounts.json` (beserta nomornya) dan tetap ada setelah restart.
5. **Auto-join grup** — setelah terhubung, akun langsung berusaha masuk grup target dari `.env`:
   - bila `GROUP_INVITE_CODE` / `GROUP_INVITE_LINK` diisi → gabung sendiri lewat undangan;
   - bila hanya `GROUP_JID` → akun lain yang sudah di dalam grup mencoba menambahkannya (perlu admin bila grup membatasi penambahan);
   - JID hasil join via invite tercetak di log — salin ke `GROUP_JID` agar arah grup pasti.
6. **Percakapan antar-bot di grup** — orchestrator (`src/group-chat.ts`) menjalankan sesi obrolan: jeda acak 20–45 menit antar sesi, 4–8 giliran per sesi, peserta 2–4 akun bergantian (tidak ada akun yang bicara dua kali berturut-turut), topik santai acak, tiap pesan digenerate AI dari konteks obrolan dan dikirim dengan jeda berpikir + status mengetik seperti manusia. Butuh minimal 2 akun online di grup dan hanya berjalan pada jam aktif.
7. **Pesan manusia di grup target** — didedupe antar akun (semua akun menerima event yang sama) dan dijawab oleh **satu** akun acak saja. Chat personal ke tiap akun tetap dibalas akun itu sendiri.
8. **Jadwal tidur bersama** — di luar jam aktif (`08:00–12:00` & `16:00–20:00` Asia/Jakarta secara bawaan) semua bot tidur: DM diabaikan, percakapan grup berhenti.

## Menu Console

Saat bot hidup, dashboard menampilkan menu ini (ketik angkanya, lalu Enter; Enter kosong = refresh dashboard):

| Menu | Fungsi |
|---|---|
| `1` Tambah akun baru | Nama (opsional) + nomor HP → akun dibuat, antre pairing, kode tampil di dashboard |
| `2` Pairing / sambungkan akun | Pilih akun belum terhubung → konfirmasi/isi nomor → kode pairing diminta |
| `3` Daftar akun & status | Semua akun + status + nomor + grup |
| `4` Log chat | 30 aktivitas chat terakhir (DM + grup) |
| `5` Log sistem | 30 log terakhir |
| `6` Logout akun | Pilih akun → logout & hapus sesi (pairing ulang lewat menu 2, nomor tetap tersimpan) |
| `7` Hapus akun | Pilih akun → logout + hapus sesi + keluarkan dari registry |
| `0` Keluar | Matikan semua bot dengan bersih |

## Struktur Project

```
bot-trainer/
├── package.json
├── tsconfig.json
├── .env.example          # salin jadi .env, lalu isi
├── .gitignore
├── README.md
├── data/
│   └── accounts.json     # registry akun (dibuat & diperbarui otomatis)
├── auth_info/            # sesi per akun: auth_info/<id>/ (JANGAN dibagikan)
└── src/
    ├── index.ts          # AccountManager + loop menu console
    ├── bot-account.ts    # satu akun = satu socket: pairing code, reconnect, DM, auto-join grup
    ├── ui.ts             # dashboard console: status, akun, log chat/sistem, menu
    ├── accounts.ts       # registry akun (muat/simpan JSON, id otomatis)
    ├── group-chat.ts     # orchestrator percakapan antar-bot di grup
    ├── config.ts         # konfigurasi .env (jadwal, grup, AI, jeda)
    ├── session.ts        # siklus hidup sesi per akun
    ├── scheduler.ts      # jam aktif/tidur (node-cron + Intl timezone)
    ├── human-delay.ts    # jeda berpikir acak, durasi typing dinamis
    ├── ai.ts             # @google/genai (Gemini 2.5 Flash), few-shot slang, penalti anti-repetisi, sanitize, fallback
    └── handler.ts        # extract teks, memori percakapan, antrean per chat
```

## Dependencies

| Package | Fungsi |
|---|---|
| `@whiskeysockets/baileys` | WhatsApp gateway (multi-device) |
| `@google/genai` | SDK resmi Google Gen AI — model Gemini 2.5 Flash (text-only) |
| `node-cron` | Penjadwal transisi jam aktif/tidur |
| `dotenv` | Memuat `.env` |
| `pino` | Logger internal Baileys |
| `https-proxy-agent` | Dukungan proxy environment untuk WebSocket (otomatis bila ada) |
| `tsx`, `typescript`, `@types/node`, `@types/node-cron` | Toolchain TypeScript (dev) |

## Cara Menjalankan

Butuh **Node.js ≥ 20**.

```bash
npm install
cp .env.example .env   # isi GROUP_JID / GROUP_INVITE_LINK & GEMINI_API_KEY
npm start
```

Alur pertama kali:

1. Bot membuat akun bawaan `bot-1`. Di dashboard, pilih menu **2** → pilih `bot-1` → masukkan nomor HP-nya → kode pairing tampil; masukkan kode itu di HP akun pertama.
2. Setelah terhubung, `bot-1` otomatis gabung grup target (via invite link bila diisi).
3. Di console yang sama, pilih menu **1** → isi nama (opsional) + nomor HP akun kedua → kode pairing `bot-2` tampil (atau antre di belakang pairing yang sedang berjalan). Ulangi untuk akun berikutnya.
4. Begitu ≥2 akun online di grup dan jam aktif tiba, sesi percakapan antar-bot mulai sendiri.

Di VPS, jalankan di dalam `tmux`/`screen` atau service (systemd/pm2) supaya menu console tetap bisa dipakai dan proses tidak mati saat SSH ditutup. Perkiraan beban: tiap akun menambah ±80–150 MB RAM (socket + store minimal) — 5 akun masih nyaman di VPS 1–2 GB, puluhan akun sebaiknya naikkan RAM dan naikkan juga jeda antar sesi grup.

## Konfigurasi (.env) — ringkas

| Variabel | Bawaan | Keterangan |
|---|---|---|
| `AUTH_BASE_DIR` | `auth_info` | Folder basis sesi per akun |
| `ACCOUNTS_FILE` | `data/accounts.json` | Registry akun |
| `GROUP_JID` | kosong | JID grup target `…@g.us` |
| `GROUP_INVITE_LINK` / `GROUP_INVITE_CODE` | kosong | Undangan grup agar akun baru bisa gabung sendiri |
| `GROUP_CHAT_ENABLED` | `true` | Percakapan antar-bot di grup |
| `GROUP_CHAT_INTERVAL_MIN/MAX_MINUTES` | `20` / `45` | Jeda acak antar sesi obrolan |
| `GROUP_CHAT_MIN/MAX_TURNS` | `4` / `8` | Giliran bicara per sesi |
| `GROUP_CHAT_TURN_GAP_MIN/MAX_MS` | `4000` / `12000` | Jeda ekstra antar giliran |
| `BOT_TIMEZONE` | `Asia/Jakarta` | Zona waktu jadwal |
| `ACTIVE_WINDOWS` | `08:00-12:00,16:00-20:00` | Jendela jam aktif semua akun |
| `GEMINI_API_KEY` | kosong = mode fallback | API key Google AI Studio |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model Gemini |
| `GEMINI_TEMPERATURE` | `0.9` | Variasi pilihan kata |
| `GEMINI_PRESENCE_PENALTY` | `0.6` | Penalti topik/kata yang sudah muncul |
| `GEMINI_FREQUENCY_PENALTY` | `0.5` | Penalti pengulangan kata dalam satu balasan |
| `GEMINI_MAX_OUTPUT_TOKENS` | `120` | Batas token keluaran per balasan |
| `THINK_DELAY_MIN/MAX_MS` | `3000` / `7000` | Rentang jeda berpikir acak |
| `TYPING_MS_PER_CHAR` / `TYPING_MAX_MS` | `40` / `6000` | Simulasi mengetik |
| `MARK_AS_READ` | `true` | Centang biru saat jam aktif |
| `RESPOND_TO_GROUPS` | `false` | Balas juga di grup selain grup target |
| `LOG_LEVEL` | `silent` | Level log pino Baileys |

Provider AI: **Google Gemini** saja, lewat SDK resmi `@google/genai` (`new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })`), model bawaan `gemini-2.5-flash`. Gaya jawaban dikunci tiga lapis: `systemInstruction` yang melarang kata baku, **few-shot prompting** di `contents` (3 contoh percakapan formal → santai selalu mendahului riwayat chat asli), dan filter regex `sanitizeReply` di kode (lowercase paksa, kata baku yang lolos diganti slang — mis. `tidak` → `ga`, tanda baca di akhir kalimat dibuang). Anti repetisi diatur di config API: `temperature 0.9`, `presencePenalty 0.6`, `frequencyPenalty 0.5`. Satu konfigurasi AI dipakai bersama oleh semua akun. Migrasi dari versi Groq/OpenAI-compatible: ganti nama `AI_API_KEY` → `GEMINI_API_KEY` di `.env` (nama lama masih diterima sebagai fallback, tapi `AI_BASE_URL`/`AI_MODEL` tidak dipakai lagi).

## Catatan

- Jangan menjalankan dua proses dengan `AUTH_BASE_DIR` / `ACCOUNTS_FILE` yang sama.
- Folder `auth_info/` dan file `.env` tidak ikut ter-commit (`.gitignore`) — cadangkan folder sesi itu secara privat bila perlu.
- Percakapan grup sengaja digerakkan orchestrator, bukan reaksi pesan-masuk, supaya tidak terjadi loop bot-membalas-bot dan tidak semua akun menjawab serentak.
