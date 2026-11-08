import { GoogleGenAI, type Content } from '@google/genai';
import { config } from './config.js';

/**
 * Integrasi AI text-only lewat SDK resmi Google Gen AI (@google/genai)
 * dengan model Gemini 2.5 Flash.
 *
 * Client diinisialisasi persis seperti dokumentasi resmi:
 *   const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
 * (Nilai yang sama juga terbaca lewat config.ai.apiKey dari file `.env`,
 *  dengan fallback warisan AI_API_KEY agar `.env` lama tidak langsung mati.)
 *
 * Gaya bahasa dikunci di TIGA lapis:
 *   1. `systemInstruction` di config generateContent — larangan keras
 *      kata baku + aturan huruf kecil / tanpa markdown / 1–3 kalimat.
 *   2. Few-shot prompting di `contents` — 3 pasang contoh percakapan
 *      formal → santai yang selalu mendahului riwayat chat asli, jadi
 *      model meniru POLA contohnya, bukan sekadar membaca instruksi.
 *   3. `sanitizeReply()` di sisi kode — benteng terakhir berbasis regex:
 *      lowercase paksa, kata baku yang lolos diganti slang, tanda titik
 *      di akhir kalimat dibuang.
 *
 * Anti repetisi diatur di config API: temperature 0.9 +
 * presencePenalty 0.6 + frequencyPenalty 0.5 (lihat config.ts —
 * ketiganya bisa ditimpa lewat `.env`).
 *
 * Bila GEMINI_API_KEY kosong atau API sedang error, bot memakai balasan
 * cadangan kasual bawaan — warming up tetap jalan, tidak pernah crash
 * hanya karena API bermasalah.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * System instruction (persis spesifikasi): mengunci gaya mengetik ke
 * bahasa Indonesia TIDAK baku — kata baku seperti 'saya', 'kamu',
 * 'anda', 'tidak', 'adalah', 'halo', 'terima kasih', 'baik' dilarang.
 */
export const SYSTEM_INSTRUCTION =
  "You are a young Indonesian close friend typing a WhatsApp chat. CRITICAL: Never use formal Indonesian words (Bahasa Baku). Absolutely forbidden to use words like 'saya', 'kamu', 'anda', 'tidak', 'adalah', 'halo', 'terima kasih', 'baik'. Always convert formal inputs into extreme daily text-slang, shortcuts, lowercase only, no markdown, and no final sentence punctuation. Keep responses strictly between 1 to 3 short sentences. Avoid repeating the exact same phrases or slang in consecutive responses.";

/** Alias nama lama agar import lain tidak pecah. */
export const SYSTEM_PROMPT = SYSTEM_INSTRUCTION;

/**
 * Few-shot prompting: contoh percakapan kaku → santai.
 * Array ini SELALU diletakkan paling depan di `contents`, sebelum
 * riwayat chat asli dan pesan terbaru, persis pola dokumentasi Gemini.
 */
export const FEW_SHOT_CONTENTS: readonly Content[] = [
  // Contoh Skenario 1 (Mengubah total gaya formal menjadi kasual)
  { role: 'user', parts: [{ text: 'Halo, apa kabar? Kamu sedang sibuk tidak?' }] },
  { role: 'model', parts: [{ text: 'wkwk aman bray tumben nanya kabar, lg rebahan aja nih gw. lu sendiri pgn ngapain' }] },

  // Contoh Skenario 2 (Mengubah total gaya penjelasan kaku menjadi santai)
  { role: 'user', parts: [{ text: 'Saya ingin menanyakan sesuatu kepada Anda.' }] },
  { role: 'model', parts: [{ text: 'nanya apaan tinggal ngomong aja kali santai aja sm gw mah gpp' }] },

  // Contoh Skenario 3 (Respon singkat khas manusia)
  { role: 'user', parts: [{ text: 'Apakah kamu sudah makan siang hari ini?' }] },
  { role: 'model', parts: [{ text: 'udh tadi siang bray kenyang bgt gw, lu udh belom' }] },
];

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI | undefined {
  if (!config.ai.apiKey) return undefined;
  // Inisialisasi resmi @google/genai — API key dari environment variable.
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY?.trim() || config.ai.apiKey });
  return client;
}

const FALLBACK_REPLIES: readonly string[] = [
  'oalah iya juga ya wkwk',
  'hmm iya sih, gw baru ngeh juga',
  'wkwk bener juga lu',
  'iya udh, gpp santai aja',
  'oalah gitu toh, baru tau gw',
  'hehe iya, lagian juga gitu kan',
  'btw iya sih, masuk akal bgt',
  'yaudah gitu aja dulu kali ya wkwk',
  'gw setuju sih sama lu',
  'anjir iya, kok bisa gitu ya wkwk',
];

let lastFallbackIndex = -1;

/** Balasan cadangan kasual — dipakai saat tidak ada API key / API error. */
export function fallbackReply(): string {
  let index = Math.floor(Math.random() * FALLBACK_REPLIES.length);
  if (index === lastFallbackIndex) index = (index + 1) % FALLBACK_REPLIES.length;
  lastFallbackIndex = index;
  return FALLBACK_REPLIES[index] ?? FALLBACK_REPLIES[0]!;
}

/**
 * Penggantian kata baku → gaul (benteng terakhir, dijalankan SETELAH
 * teks diratakan ke huruf kecil). Urutan penting: frasa dua kata dan
 * bentuk yang lebih panjang diganti lebih dulu.
 */
const FORMAL_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/\bterima kasih\b/g, 'makasih'],
  [/\bbaiklah\b/g, 'oke deh'],
  [/\bsaya\b/g, 'gw'],
  [/\baku\b/g, 'gw'],
  [/\bkamu\b/g, 'lu'],
  [/\banda\b/g, 'lu'],
  [/\btidak\b/g, 'ga'],
  [/\badalah\b/g, 'itu'],
  [/\bhalo\b/g, 'oi'],
  [/\bbaik\b/g, 'oke'],
  [/\bsudah\b/g, 'udh'],
  [/\bbelum\b/g, 'belom'],
  [/\bsedang\b/g, 'lg'],
  [/\bingin\b/g, 'pgn'],
  [/\bmengapa\b/g, 'kenapa'],
  [/\bbagaimana\b/g, 'gimana'],
  [/\bsangat\b/g, 'bgt'],
  [/\bsekali\b/g, 'bgt'],
];

/** Buang tanda baca kalimat (., !, ?) yang menempel di AKHIR teks. */
function stripFinalPunctuation(text: string): string {
  return text.replace(/[\s]*[.!?]+["')\]]*\s*$/g, '').trim();
}

/**
 * Penegak gaya di sisi kode (tidak mengandalkan model saja):
 * buang markdown, ratakan baris baru, huruf kecil semua, ganti kata
 * baku yang lolos jadi slang, runtuhkan tawa yang diulang beruntun,
 * potong jadi maksimal 3 kalimat dan maksimal 240 karakter, dan buang
 * tanda titik/tanda baca di akhir kalimat.
 */
export function sanitizeReply(raw: string): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ') // code fence
    .replace(/[*_~`#>]+/g, '') // markdown: bold/italic/strike/code/heading/quote
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link markdown -> teksnya saja
    .replace(/^[\s]*[-•]\s+/gm, '') // bullet di awal baris
    .replace(/\s*\n\s*/g, ' ') // baris baru -> spasi
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();

  // Kata baku yang masih lolos dari model -> paksa jadi gaul.
  for (const [pattern, replacement] of FORMAL_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  // Tawa/slang yang diulang beruntun ("wkwk wkwk wkwk") -> sekali saja.
  text = text.replace(/\b(wkwk|haha|hehe)(\s+\1\b)+/g, '$1');

  // Maksimal 3 kalimat.
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (sentences && sentences.length > 3) {
    text = sentences.slice(0, 3).join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  // Maksimal 240 karakter, potong di batas kata.
  if (text.length > 240) {
    text = text.slice(0, 240).replace(/\s+\S*$/, '').trim();
  }

  // Benteng terakhir spesifikasi: tanpa tanda baca di akhir kalimat.
  return stripFinalPunctuation(text);
}

/** Riwayat chat internal (user/assistant) -> format contents Gemini (user/model). */
export function formatHistory(history: readonly ChatTurn[]): Content[] {
  return history.slice(-10).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));
}

/**
 * Susun `contents` lengkap persis spesifikasi: few-shot pengunci gaya
 * paling depan, lalu riwayat chat riil, lalu pesan terbaru sebagai
 * giliran 'user' terakhir.
 */
export function buildContents(history: readonly ChatTurn[], currentUserMessage: string): Content[] {
  return [
    ...FEW_SHOT_CONTENTS,
    ...formatHistory(history),
    { role: 'user', parts: [{ text: currentUserMessage }] },
  ];
}

/**
 * Minta satu balasan AI untuk `userText` memakai Gemini 2.5 Flash,
 * dengan konteks percakapan terakhir (`history`) supaya obrolannya
 * nyambung seperti chat manusia. Struktur `contents` persis spesifikasi:
 * few-shot dulu, lalu riwayat chat riil, lalu pesan terbaru.
 * Tidak pernah throw — kegagalan apa pun jatuh ke fallbackReply().
 * Hasil final mengalir ke replyNaturally() pemanggil (jeda berpikir
 * acak → status composing → kirim → paused), sama seperti sebelumnya.
 */
export async function getAIResponse(history: readonly ChatTurn[], currentUserMessage: string): Promise<string> {
  const ai = getClient();
  if (!ai) return fallbackReply();

  try {
    const response = await ai.models.generateContent({
      model: config.ai.model,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: config.ai.temperature,
        presencePenalty: config.ai.presencePenalty,
        frequencyPenalty: config.ai.frequencyPenalty,
        maxOutputTokens: config.ai.maxOutputTokens,
      },
      // Few-shot dulu, lalu riwayat chat riil, lalu pesan terbaru.
      contents: buildContents(history, currentUserMessage),
    });
    const clean = sanitizeReply(response.text ?? '');
    return clean.length > 0 ? clean : fallbackReply();
  } catch (err) {
    console.warn('[ai] Panggilan Gemini gagal, pakai balasan cadangan:', err instanceof Error ? err.message : err);
    return fallbackReply();
  }
}

/** Nama yang dipakai pemanggil lama (bot-account.ts, index.ts, group-chat). */
export const getAiReply = getAIResponse;
