import { WEEKDAY_KEYS, type WeekdayKey } from "./schedule";

export interface PlainDate {
  year: number;
  month: number;
  day: number;
}

export interface PlainDateTime extends PlainDate {
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}:${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...options,
  });
  formatterCache.set(key, formatter);
  return formatter;
}

function readPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const match = parts.find((part) => part.type === type)?.value;
  if (!match) {
    throw new Error(`Missing ${type} part`);
  }
  return match;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    getFormatter(timeZone, { year: "numeric" }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseTimeText(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  return {
    hour: Number.parseInt(match[1], 10),
    minute: Number.parseInt(match[2], 10),
  };
}

export function compareTimes(left: string, right: string): number {
  const leftParts = parseTimeText(left);
  const rightParts = parseTimeText(right);
  if (!leftParts || !rightParts) {
    throw new Error("compareTimes requires valid HH:MM values");
  }

  return (leftParts.hour * 60 + leftParts.minute) - (rightParts.hour * 60 + rightParts.minute);
}

export function getZonedDateTime(timestampMs: number, timeZone: string): PlainDateTime {
  const formatter = getFormatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(timestampMs));

  return {
    year: Number.parseInt(readPart(parts, "year"), 10),
    month: Number.parseInt(readPart(parts, "month"), 10),
    day: Number.parseInt(readPart(parts, "day"), 10),
    hour: Number.parseInt(readPart(parts, "hour"), 10),
    minute: Number.parseInt(readPart(parts, "minute"), 10),
  };
}

export function currentPlainDate(timeZone: string, nowMs: number): PlainDate {
  const value = getZonedDateTime(nowMs, timeZone);
  return {
    year: value.year,
    month: value.month,
    day: value.day,
  };
}

export function addDays(date: PlainDate, offset: number): PlainDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function weekdayKeyForPlainDate(date: PlainDate): WeekdayKey {
  const jsDay = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const sundayFirst = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
  return sundayFirst[jsDay];
}

export function plainDateKey(date: PlainDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function zonedDateTimeToUtcMs(value: PlainDateTime, timeZone: string): number {
  let guess = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);

  for (let i = 0; i < 4; i += 1) {
    const actual = getZonedDateTime(guess, timeZone);
    const targetPlainMs = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
    const actualPlainMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = targetPlainMs - actualPlainMs;

    if (delta === 0) {
      return guess;
    }

    guess += delta;
  }

  return guess;
}

export function formatDayLabel(timestampMs: number, timeZone: string): string {
  return getFormatter(timeZone, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(timestampMs));
}

export function formatTimeLabel(timestampMs: number, timeZone: string): string {
  return getFormatter(timeZone, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

export function formatTimeRange(startMs: number, endMs: number, timeZone: string): string {
  return `${formatTimeLabel(startMs, timeZone)} - ${formatTimeLabel(endMs, timeZone)}`;
}

export function nextFourteenDays(nowMs: number, timeZone: string): PlainDate[] {
  const start = currentPlainDate(timeZone, nowMs);
  return Array.from({ length: 14 }, (_, index) => addDays(start, index));
}

export { WEEKDAY_KEYS };
