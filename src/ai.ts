import OpenAI from 'openai';
import { config } from './config.js';

/**
 * Integrasi AI text-only lewat OpenAI SDK.
 *
 * `baseURL` + `apiKey` fleksibel dari `.env`, jadi provider apa pun yang
 * OpenAI-compatible bisa dipakai tanpa ubah kode:
 *   Groq       https://api.groq.com/openai/v1
 *   Gemini     https://generativelanguage.googleapis.com/v1beta/openai/
 *   OpenRouter https://openrouter.ai/api/v1   (akses Muse, GPT, dll.)
 *   OpenAI     https://api.openai.com/v1
 *
 * Bila AI_API_KEY kosong atau API sedang error, bot memakai balasan
 * cadangan kasual bawaan — warming up tetap jalan, tidak pernah crash
 * hanya karena API bermasalah.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * System prompt: memaksa gaya chat santai anak muda Indonesia —
 * huruf kecil semua, slang, tanpa markdown, maksimal 1–3 kalimat pendek.
 * Hasilnya tetap dibersihkan lagi oleh sanitizeReply() di bawah, jadi
 * gaya ini terjaga walau model sesekali bandel.
 */
export const SYSTEM_PROMPT = [
  'kamu adalah anak muda indonesia biasa yang lagi chatting santai di whatsapp sama temen.',
  'jawab selalu pakai bahasa indonesia gaul dan santai, pakai kata kayak: gw, lu, udh, gpp, ga, bgt, wkwk, sih, dong, yaudah, oalah, btw.',
  'semua huruf kecil, jangan pakai huruf kapital sama sekali.',
  'tanpa format markdown, tanpa bullet, tanpa bold, tanpa emoji berlebihan.',
  'jawaban maksimal 1 sampai 3 kalimat pendek saja, jangan panjang-panjang.',
  'jangan pernah mengaku kamu ai atau bot, jangan pakai bahasa formal, jangan membuka jawaban dengan sapaan kaku.',
  'kalau ditanya hal yang kamu ga tau, jawab santai aja kayak manusia, misal ngaku ga tau atau becanda dikit.',
].join(' ');

let client: OpenAI | undefined;

function getClient(): OpenAI | undefined {
  if (!config.ai.apiKey) return undefined;
  client ??= new OpenAI({ apiKey: config.ai.apiKey, baseURL: config.ai.baseURL });
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
 * Penegak gaya di sisi kode (tidak mengandalkan model saja):
 * buang markdown, ratakan baris baru, huruf kecil semua,
 * potong jadi maksimal 3 kalimat dan maksimal 240 karakter.
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

  // Maksimal 3 kalimat.
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (sentences && sentences.length > 3) {
    text = sentences.slice(0, 3).join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  // Maksimal 240 karakter, potong di batas kata.
  if (text.length > 240) {
    text = text.slice(0, 240).replace(/\s+\S*$/, '').trim();
  }
  return text;
}

/**
 * Minta satu balasan AI untuk `userText`, dengan konteks percakapan
 * terakhir (`history`) supaya obrolannya nyambung seperti chat manusia.
 * Tidak pernah throw — kegagalan apa pun jatuh ke fallbackReply().
 */
export async function getAiReply(history: readonly ChatTurn[], userText: string): Promise<string> {
  const openai = getClient();
  if (!openai) return fallbackReply();

  try {
    const completion = await openai.chat.completions.create({
      model: config.ai.model,
      temperature: config.ai.temperature,
      max_tokens: config.ai.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-10),
        { role: 'user', content: userText },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    const clean = sanitizeReply(raw);
    return clean.length > 0 ? clean : fallbackReply();
  } catch (err) {
    console.warn('[ai] Panggilan API gagal, pakai balasan cadangan:', err instanceof Error ? err.message : err);
    return fallbackReply();
  }
}
