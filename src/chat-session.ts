/**
 * Kontrol SESI CHAT manual dari menu console (tombol Start/Stop).
 *
 * "Sesi chat" = seluruh aktivitas mengobrol bot:
 *   - sesi percakapan antar-bot di grup target (group-chat.ts),
 *   - balasan ke chat personal manusia (bot-account.ts),
 *   - balasan ke pesan manusia di grup target (index.ts).
 *
 * Saat proses baru menyala sesi chat BERHENTI — akun tetap terhubung
 * dan pairing tetap jalan, tetapi bot tidak mengobrol sama sekali
 * sampai user menekan Start di menu console. Stop menghentikan sesi
 * yang sedang berjalan (termasuk di tengah sesi grup, antar giliran).
 *
 * Sesi chat adalah saklar DI ATAS jadwal jam aktif: obrolan hanya
 * terjadi bila sesi menyala DAN sekarang jam aktif (scheduler.ts).
 */

let sessionRunning = false;

export function isChatSessionRunning(): boolean {
  return sessionRunning;
}

export function startChatSession(): void {
  sessionRunning = true;
}

export function stopChatSession(): void {
  sessionRunning = false;
}
