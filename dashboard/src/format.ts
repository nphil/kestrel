export function timestamp(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A date formatter costs about a millisecond to build on a phone-class CPU, and every tile and row of a list asks for one: the
 * panel's lists spent a tenth of the time to open a species sheet on building the same four formatters over and over.
 * Each is built the first time it is needed and kept (the language and the time zone of a page do not change while it is open). */
function once(options: Intl.DateTimeFormatOptions): () => Intl.DateTimeFormat {
  let built: Intl.DateTimeFormat | undefined;
  return () => (built ??= new Intl.DateTimeFormat(undefined, options));
}
const clockFormat = once({ hour: "numeric", minute: "2-digit" });
const dateTimeFormat = once({ dateStyle: "medium", timeStyle: "short" });
const weekdayFormat = once({ weekday: "short" });
const monthDayFormat = once({ month: "short", day: "numeric" });

export function clockTime(value: string | number | null | undefined): string {
  const ms = timestamp(value);
  if (ms === null) return "Time unavailable";
  return clockFormat().format(ms);
}

export function dateTime(value: string | number | null | undefined): string {
  const ms = timestamp(value);
  if (ms === null) return "Time unavailable";
  return dateTimeFormat().format(ms);
}

/** "Just now", "3 min ago", "2 h ago", "5 d ago". */
export function ago(value: string | number | null | undefined, now = Date.now()): string {
  const ms = timestamp(value);
  if (ms === null) return "Time unavailable";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** How long ago something happened, for the middle of a sentence: "just now", "3 min ago", "4:45 AM",
 * "yesterday 4:45 PM", "Mon 4:45 PM", then a date. Start a sentence with `sentence(when(...))`. */
export function when(value: string | number | null | undefined, now = Date.now()): string {
  const ms = timestamp(value);
  if (ms === null) return "time unknown";
  if (now - ms < 3_600_000) return ago(ms, now).toLowerCase();
  const startOfDay = (time: number): number => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  const clock = clockTime(ms);
  if (days <= 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  if (days < 7) return `${weekdayFormat().format(ms)} ${clock}`;
  return monthDayFormat().format(ms);
}

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatMiB(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
