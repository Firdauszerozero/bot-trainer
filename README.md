# Bot Trainer — WhatsApp Warming-Up Bot (TypeScript)

Bot WhatsApp untuk **warming up / training akun**: menjaga pola aktivitas akun tetap terbaca natural seperti pemakaian manusia biasa. Dibangun di atas [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) (TypeScript, ESM) dengan balasan AI text-only bergaya chat santai anak muda Indonesia.

> **Sifat bot ini: HANYA membalas.** Tidak ada pengiriman proaktif, broadcast, auto-chat ke nomor asing, atau pesan terjadwal ke siapa pun di dalam kode ini. Bot merespons chat personal yang masuk — hanya pada jam aktif.

> ⚠️ **Peringatan ban (jujur, bukan basa-basi):** Baileys adalah klien **tidak resmi**. Pola human-like di bot ini mengurangi perilaku yang mencolok sebagai bot, tetapi **tidak ada cara yang menjamin 100% bebas ban** selama memakai klien tidak resmi — gelombang ban berkala tetap ada. Gunakan **nomor cadangan**, jangan nomor utama. Nomor yang sudah berumur dengan riwayat pemakaian manusia normal jauh lebih tahan daripada nomor segar.

---

## Fitur

1. **Authentication & Connection**
   - Login pertama kali dengan **pairing code nomor HP** — QR code tidak dipakai sama sekali.
   - Sesi tersimpan lokal (`auth_info/`) dan dipakai ulang otomatis saat reconnect / restart.
   - Sisa sesi setengah-pairing dibersihkan otomatis; sesi terdaftar tidak pernah dihapus kecuali perintah `.logout` di console bot.
   - Reconnect otomatis: putus biasa → 5 detik, `restartRequired` (515, normal sesudah pairing) → 1 detik, logout/401 → sesi dihapus dan pairing ulang ditawarkan (maks. 2× berturut-turut).

2. **Scheduler jam aktif & istirahat**
   - Jendela aktif bisa diatur, bawaan: **08:00–12:00** dan **16:00–20:00** (`Asia/Jakarta`).
   - Di luar jendela, bot **tidur**: pesan masuk diabaikan total — tidak dibaca, tidak dibalas, tidak ada status online/typing.
   - Transisi bangun/tidur dicatat di log, diperiksa tiap menit via `node-cron` + perhitungan jam berdasarkan zona waktu (benar walau zona waktu server berbeda). Jendela boleh melewati tengah malam (mis. `21:00-01:00`).

3. **Jeda acak human-like**
   - Jeda berpikir acak **3–7 detik** sebelum mulai merespons — tidak pernah membalas seketika.
   - Status **`composing`** ("sedang mengetik…") dikirim ke chat target.
   - Durasi mengetik **dinamis mengikuti panjang balasan** (panjang × 40 ms/karakter + jitter acak), maksimal **6 detik**.
   - Sesudah itu pesan dikirim dan status mengetik dimatikan (`paused`).

4. **Integrasi AI text-only (OpenAI SDK)**
   - `baseURL` + `apiKey` fleksibel dari `.env` — provider OpenAI-compatible apa pun bisa dipakai: **Groq, Gemini, OpenRouter (Muse/GPT), OpenAI**.
   - System prompt memaksa gaya: slang Indonesia (`wkwk, gw, lu, udh, gpp, ga, bgt`), **huruf kecil semua**, **tanpa markdown**, **maksimal 1–3 kalimat pendek**.
   - Gaya itu juga **ditegakkan di kode** (`sanitizeReply`): markdown dibuang, teks direndahkan ke huruf kecil, dipotong ke ≤3 kalimat / ≤240 karakter — walau model sesekali bandel, output tetap konsisten.
   - Konteks 6 giliran terakhir per chat disimpan (memori proses) supaya obrolan nyambung.
   - Tanpa API key (atau saat API error), bot memakai **balasan cadangan kasual bawaan** — tidak pernah crash gara-gara API.

---

## Struktur Project

```
bot-trainer/
├── package.json
├── tsconfig.json
├── .env.example          # salin jadi .env, lalu isi
├── .gitignore
├── README.md
└── src/
    ├── index.ts          # entry: koneksi Baileys, pairing code, reconnect, .logout
    ├── config.ts         # semua konfigurasi dari .env (termasuk parsing ACTIVE_WINDOWS)
    ├── session.ts        # siklus hidup sesi: pakai ulang sesi terdaftar, bersihkan sisa pairing
    ├── scheduler.ts      # jam aktif/tidur (node-cron + Intl timezone)
    ├── human-delay.ts    # jeda berpikir acak, durasi typing dinamis, replyNaturally()
    ├── ai.ts             # OpenAI SDK, system prompt slang, sanitizeReply(), fallback
    └── handler.ts        # saring pesan masuk, antrean per chat, konteks percakapan
```

## Dependencies

| Package | Fungsi |
|---|---|
| `@whiskeysockets/baileys` | WhatsApp gateway (multi-device) |
| `openai` | SDK untuk API AI text-only (baseURL fleksibel) |
| `node-cron` | Penjadwal transisi jam aktif/tidur |
| `dotenv` | Memuat `.env` |
| `pino` | Logger internal Baileys |
| `https-proxy-agent` | Dukungan proxy environment untuk WebSocket (opsional, otomatis) |
| `tsx`, `typescript`, `@types/node`, `@types/node-cron` | Toolchain TypeScript (dev) |

## Cara Menjalankan

Butuh **Node.js ≥ 20**.

```bash
npm install
cp .env.example .env   # lalu edit .env: isi BOT_PHONE_NUMBER & AI_API_KEY
npm start
```

Saat sesi masih kosong, console menampilkan kode pairing:

```
╔════════════════════════════════════════════╗
   🔑  KODE PAIRING WHATSAPP:  XXXX-XXXX
   📱  Nomor: +628xxxxxxx
   Masukkan di: WhatsApp → Perangkat tertaut →
   Tautkan perangkat → "Tautkan dengan nomor telepon"
╚════════════════════════════════════════════╝
```

Masukkan kode itu di HP nomor yang sama. Setelah terhubung, sesi tersimpan di `auth_info/` — start berikutnya langsung tersambung tanpa pairing lagi.

Perintah console bot: ketik `.logout` di terminal untuk melepas perangkat + menghapus sesi + berhenti.

## Konfigurasi (.env)

| Variabel | Bawaan | Keterangan |
|---|---|---|
| `BOT_PHONE_NUMBER` | — (wajib untuk pairing) | Nomor HP, format `628xxxx` (digit saja) |
| `AUTH_DIR` | `auth_info` | Folder sesi — **jangan dibagikan**, setara akun |
| `BOT_TIMEZONE` | `Asia/Jakarta` | Zona waktu jadwal |
| `ACTIVE_WINDOWS` | `08:00-12:00,16:00-20:00` | Jendela jam aktif, pisahkan koma |
| `AI_API_KEY` | kosong = mode fallback | API key provider AI |
| `AI_BASE_URL` | `https://api.groq.com/openai/v1` | Endpoint OpenAI-compatible |
| `AI_MODEL` | `llama-3.3-70b-versatile` | Model text |
| `AI_TEMPERATURE` | `0.9` | Kreativitas jawaban |
| `AI_MAX_TOKENS` | `120` | Batas panjang jawaban mentah |
| `THINK_DELAY_MIN_MS` / `THINK_DELAY_MAX_MS` | `3000` / `7000` | Rentang jeda berpikir acak |
| `TYPING_MS_PER_CHAR` | `40` | Kecepatan mengetik simulasi |
| `TYPING_MAX_MS` | `6000` | Batas maksimal durasi mengetik |
| `MARK_AS_READ` | `true` | Centang biru saat jam aktif sebelum membalas |
| `RESPOND_TO_GROUPS` | `false` | Ikut membalas di grup atau tidak |
| `LOG_LEVEL` | `silent` | Level log pino Baileys |

Contoh provider:

- **Groq** — `AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_MODEL=llama-3.3-70b-versatile`
- **Gemini** — `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `AI_MODEL=gemini-2.0-flash`
- **Muse via OpenRouter** — `AI_BASE_URL=https://openrouter.ai/api/v1`, `AI_MODEL=anthropic/claude-3.5-haiku` (Anthropic tidak menyediakan endpoint OpenAI-compatible langsung, jadi lewat OpenRouter)

## Catatan Pemakaian

- Panaskan nomor seperti manusia dulu: beberapa hari pemakaian normal (chat, foto profil, status) sebelum bot dipasang jauh lebih aman daripada nomor segar yang langsung dihubungkan ke bot.
- Volume tetap wajar: bot ini membalas secepat manusia dalam obrolan normal, tapi jangan dipakai membalas puluhan chat asing per jam.
- Jangan jalankan dua proses bot dengan folder `auth_info/` yang sama.
