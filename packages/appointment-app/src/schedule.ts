export const WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export type WeekdayKey = typeof WEEKDAY_KEYS[number];
export type ScheduleTimeField = `${WeekdayKey}${"Start" | "End"}`;

export interface DailyAvailabilityDraft {
  start: string;
  end: string;
}

export type AvailabilityDraft = Record<WeekdayKey, DailyAvailabilityDraft>;

export interface ScheduleDraft {
  title: string;
  timezone: string;
  slotDurationMinutes: string;
  availability: AvailabilityDraft;
}

export function getStartFieldName(day: WeekdayKey): `${WeekdayKey}Start` {
  return `${day}Start`;
}

export function getEndFieldName(day: WeekdayKey): `${WeekdayKey}End` {
  return `${day}End`;
}

export function createDefaultAvailability(): AvailabilityDraft {
  return {
    monday: { start: "09:00", end: "17:00" },
    tuesday: { start: "09:00", end: "17:00" },
    wednesday: { start: "09:00", end: "17:00" },
    thursday: { start: "09:00", end: "17:00" },
    friday: { start: "09:00", end: "17:00" },
    saturday: { start: "", end: "" },
    sunday: { start: "", end: "" },
  };
}

export function createDefaultScheduleDraft(timezone: string): ScheduleDraft {
  return {
    title: "Appointments",
    timezone,
    slotDurationMinutes: "30",
    availability: createDefaultAvailability(),
  };
}

export function scheduleFieldsToDraft(fields: Record<string, unknown>): ScheduleDraft {
  const fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const availability = createDefaultAvailability();

  for (const day of WEEKDAY_KEYS) {
    availability[day] = {
      start: typeof fields[getStartFieldName(day)] === "string" ? String(fields[getStartFieldName(day)]) : "",
      end: typeof fields[getEndFieldName(day)] === "string" ? String(fields[getEndFieldName(day)]) : "",
    };
  }

  return {
    title: typeof fields.title === "string" ? String(fields.title) : "Appointments",
    timezone: typeof fields.timezone === "string" ? String(fields.timezone) : fallbackTimezone,
    slotDurationMinutes:
      typeof fields.slotDurationMinutes === "number"
        ? String(fields.slotDurationMinutes)
        : "30",
    availability,
  };
}

export function draftToScheduleFields(draft: ScheduleDraft): EditableScheduleFields {
  const fields: EditableScheduleFields = {
    title: draft.title.trim(),
    timezone: draft.timezone.trim(),
    slotDurationMinutes: Number.parseInt(draft.slotDurationMinutes, 10),
  };

  for (const day of WEEKDAY_KEYS) {
    const startField = getStartFieldName(day);
    const endField = getEndFieldName(day);
    const start = draft.availability[day].start.trim();
    const end = draft.availability[day].end.trim();
    fields[startField] = start || undefined;
    fields[endField] = end || undefined;
  }

  return fields;
}
import type { EditableScheduleFields } from "./schema";
