const DEFAULTS = Object.freeze({ enabled: false, time: '09:00', timeZone: 'UTC' });
const KEYS = new Set(['enabled', 'time', 'timeZone']);
const formatters = new Map();
const FORMATTER_LIMIT = 64;

/** Validation messages never include supplied values or unknown property names. */
export class ScheduleValidationError extends Error {
  constructor(field = 'schedule') {
    super('Invalid schedule.');
    this.name = 'ScheduleValidationError';
    this.fields = { [field]: 'Invalid value.' };
  }
}

function formatterFor(timeZone) {
  // Intl versions may accept numeric offsets. Only named zones are permitted here.
  if (typeof timeZone !== 'string' || !/^[A-Za-z]/u.test(timeZone)
    || /[^A-Za-z0-9._+\/-]/u.test(timeZone)) {
    throw new ScheduleValidationError('schedule.timeZone');
  }
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    throw new ScheduleValidationError('schedule.timeZone');
  }
  const entry = { formatter, timeZone: formatter.resolvedOptions().timeZone };
  if (formatters.size >= FORMATTER_LIMIT) formatters.delete(formatters.keys().next().value);
  formatters.set(timeZone, entry);
  return entry;
}

/** Return a new, canonical schedule. Missing or undefined properties use defaults. */
export function normalizeSchedule(raw) {
  if (raw === undefined) return { ...DEFAULTS };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Reflect.ownKeys(raw).some((key) => !KEYS.has(key))) {
    throw new ScheduleValidationError();
  }
  const { enabled = false, time = '09:00', timeZone = 'UTC' } = raw;
  if (typeof enabled !== 'boolean') throw new ScheduleValidationError('schedule.enabled');
  if (typeof time !== 'string' || time.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) {
    throw new ScheduleValidationError('schedule.time');
  }
  return { enabled, time, timeZone: formatterFor(timeZone).timeZone };
}

function localParts(at, timeZone) {
  const milliseconds = at instanceof Date ? Date.prototype.getTime.call(at) : at;
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)
    || !Number.isFinite(new Date(milliseconds).getTime())) {
    throw new ScheduleValidationError('schedule.at');
  }
  const entry = formatterFor(timeZone);
  const parts = Object.fromEntries(entry.formatter.formatToParts(milliseconds)
    .map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    timeZone: entry.timeZone,
  };
}

/** Ledger date in the explicit zone; at must be a valid Date or epoch milliseconds. */
export function scheduleDate(at, timeZone) {
  return localParts(at, timeZone).date;
}

/** Exact local-minute matching only: no catch-up, timers, or DST repair heuristics. */
export function scheduleOccurrence(schedule, at = Date.now()) {
  if (schedule === null || schedule === undefined) return null;
  const normalized = normalizeSchedule(schedule);
  if (!normalized.enabled) return null;
  const occurrence = localParts(at, normalized.timeZone);
  return occurrence.time === normalized.time ? occurrence : null;
}
