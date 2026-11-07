import cron, { type ScheduledTask } from 'node-cron';
import { config, type ActiveWindow } from './config.js';

/**
 * Scheduler jam aktif / jam tidur.
 *
 * Bot hanya merespons di dalam jendela ACTIVE_WINDOWS (zona waktu
 * BOT_TIMEZONE). Di luar jendela itu bot "tidur": handler mengabaikan
 * pesan masuk sepenuhnya — tidak dibaca, tidak dibalas, tidak ada
 * presence apa pun. Bentuk tidurnya meniru manusia: akun tetap
 * tersambung, hanya tidak beraktivitas.
 *
 * Implementasi: pengecekan murni berdasarkan jam lokal di zona waktu
 * yang dikonfigurasi (jadi benar walau zona waktu server berbeda),
 * ditambah job node-cron per menit yang mencatat transisi ON/OFF.
 */

/** Menit-dalam-hari (0–1439) pada `date` menurut zona waktu `timeZone`. */
export function getLocalMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** Jendela boleh melewati tengah malam, mis. 21:00-01:00. */
export function isWithinWindow(minutes: number, window: ActiveWindow): boolean {
  if (window.startMinutes <= window.endMinutes) {
    return minutes >= window.startMinutes && minutes < window.endMinutes;
  }
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}

export function isActiveAt(date: Date): boolean {
  const minutes = getLocalMinutes(date, config.timezone);
  return config.activeWindows.some((window) => isWithinWindow(minutes, window));
}

export function isActiveNow(): boolean {
  return isActiveAt(new Date());
}

export function describeWindows(): string {
  return config.activeWindows.map((window) => window.label).join(', ');
}

let task: ScheduledTask | undefined;
let lastActive: boolean | undefined;

/**
 * Mulai job per-menit yang mencatat transisi bangun/tidur.
 * `onChange` (opsional) dipanggil setiap kali status aktif berubah.
 * Mengembalikan status aktif saat ini.
 */
export function startScheduler(onChange?: (active: boolean) => void): boolean {
  const tick = (): boolean => {
    const active = isActiveNow();
    if (lastActive !== undefined && active !== lastActive) {
      console.log(
        active
          ? `[jadwal] ☀️  Bot BANGUN — masuk jam aktif (${describeWindows()} ${config.timezone}).`
          : `[jadwal] 🌙 Bot TIDUR — di luar jam aktif (${describeWindows()} ${config.timezone}). Pesan masuk diabaikan.`,
      );
      onChange?.(active);
    }
    lastActive = active;
    return active;
  };

  const nowActive = tick();
  lastActive = nowActive;
  task = cron.schedule('* * * * *', tick, { timezone: config.timezone });
  return nowActive;
}

export function stopScheduler(): void {
  task?.stop();
  task = undefined;
}
