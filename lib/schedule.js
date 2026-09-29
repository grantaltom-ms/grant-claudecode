// Scheduling helpers. Vercel cron runs in UTC and knows nothing about
// daylight saving, so each morning job is scheduled at BOTH candidate UTC hours
// (13:xx and 14:xx) and uses this to run only when it is actually the 6 AM hour
// in Seattle. That keeps the digest at 6:30 AM year-round.

export const TIME_ZONE = 'America/Los_Angeles';

export function pacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${v.year}-${v.month}-${v.day}`,
    weekday: v.weekday,
    hour: Number(v.hour),
    minute: Number(v.minute),
  };
}

// True when `date` falls in the given local (Pacific) hour.
export function isPacificHour(date, hour) {
  return pacificParts(date).hour === hour;
}

// True when a run that started at `startedAt` happened on the same Pacific
// calendar day as `now`.
export function samePacificDay(startedAt, now = new Date()) {
  if (!startedAt) return false;
  return pacificParts(new Date(startedAt)).date === pacificParts(now).date;
}

// Clamp a model-given score onto a 1..5 scale. The One Priority post once
// showed "Confidence: 7/5" because the model was never told the scale.
export function clampScore(value, min = 1, max = 5) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
