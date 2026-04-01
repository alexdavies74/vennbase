import { CURRENT_USER } from "@vennbase/core";
import {
  createDefaultScheduleDraft,
  draftToScheduleFields,
  getEndFieldName,
  getStartFieldName,
  scheduleFieldsToDraft,
  type ScheduleDraft,
  type WeekdayKey,
} from "./schedule";
import {
  compareTimes,
  formatDayLabel,
  formatTimeRange,
  getZonedDateTime,
  isValidTimeZone,
  nextFourteenDays,
  parseTimeText,
  plainDateKey,
  weekdayKeyForPlainDate,
  zonedDateTimeToUtcMs,
} from "./time";
import type {
  AppointmentDb,
  BookingHandle,
  BookingKeyRow,
  BookingRootRef,
  RecentScheduleHandle,
  SavedBookingHandle,
  ScheduleHandle,
} from "./schema";

type AppointmentDbPort = Pick<
  AppointmentDb,
  | "create"
  | "createShareLink"
  | "getRow"
  | "joinInvite"
  | "parseInvite"
  | "query"
  | "update"
>;

export interface SlotOccurrence {
  key: string;
  dayKey: string;
  dayLabel: string;
  label: string;
  startMs: number;
  endMs: number;
}

export interface CustomerSlot extends SlotOccurrence {
  status: "available" | "taken" | "owned";
  savedBooking: SavedBookingHandle | null;
}

export interface SlotDay {
  key: string;
  label: string;
  slots: CustomerSlot[];
}

export interface OwnerBookingEntry {
  id: string;
  owner: string;
  dayKey: string;
  dayLabel: string;
  label: string;
}

export interface OwnerBookingDay {
  key: string;
  label: string;
  entries: OwnerBookingEntry[];
}

function slotKey(startMs: number, endMs: number): string {
  return `${startMs}:${endMs}`;
}

function sameRef(
  left: Pick<ScheduleHandle["ref"], "id" | "baseUrl" | "collection">,
  right: Pick<ScheduleHandle["ref"], "id" | "baseUrl" | "collection">,
): boolean {
  return left.id === right.id
    && left.collection === right.collection
    && left.baseUrl === right.baseUrl;
}

export function createInitialDraft(timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): ScheduleDraft {
  return createDefaultScheduleDraft(timezone);
}

export function validateScheduleDraft(draft: ScheduleDraft): string | null {
  if (!draft.title.trim()) {
    return "Schedule title is required.";
  }

  if (!draft.timezone.trim() || !isValidTimeZone(draft.timezone.trim())) {
    return "Choose a valid IANA timezone.";
  }

  const duration = Number.parseInt(draft.slotDurationMinutes, 10);
  if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
    return "Slot duration must be a whole number between 5 and 240 minutes.";
  }

  let hasOpenDay = false;
  for (const day of Object.keys(draft.availability) as WeekdayKey[]) {
    const start = draft.availability[day].start.trim();
    const end = draft.availability[day].end.trim();
    if (!start && !end) {
      continue;
    }

    if (!start || !end) {
      return `Enter both a start and end time for ${day}.`;
    }

    if (!parseTimeText(start) || !parseTimeText(end)) {
      return `Times for ${day} must use HH:MM in 24-hour format.`;
    }

    if (compareTimes(start, end) >= 0) {
      return `${day} must end after it starts.`;
    }

    hasOpenDay = true;
  }

  if (!hasOpenDay) {
    return "Open at least one day of the week.";
  }

  return null;
}

export function generateSlotOccurrences(
  schedule: Pick<ScheduleHandle, "fields"> | { fields: Record<string, unknown> },
  nowMs = Date.now(),
): SlotOccurrence[] {
  const fields = schedule.fields;
  const timeZone = String(fields.timezone ?? "UTC");
  const slotDurationMinutes = Number(fields.slotDurationMinutes ?? 0);
  const durationMs = slotDurationMinutes * 60_000;
  const slots: SlotOccurrence[] = [];

  for (const date of nextFourteenDays(nowMs, timeZone)) {
    const weekday = weekdayKeyForPlainDate(date);
    const start = fields[getStartFieldName(weekday)];
    const end = fields[getEndFieldName(weekday)];
    if (typeof start !== "string" || typeof end !== "string" || !start || !end) {
      continue;
    }

    const parsedStart = parseTimeText(start);
    const parsedEnd = parseTimeText(end);
    if (!parsedStart || !parsedEnd) {
      continue;
    }

    const windowStart = zonedDateTimeToUtcMs({ ...date, ...parsedStart }, timeZone);
    const windowEnd = zonedDateTimeToUtcMs({ ...date, ...parsedEnd }, timeZone);
    if (windowEnd <= windowStart || durationMs <= 0) {
      continue;
    }

    for (let slotStart = windowStart; slotStart + durationMs <= windowEnd; slotStart += durationMs) {
      const slotEnd = slotStart + durationMs;
      if (slotStart < nowMs) {
        continue;
      }

      slots.push({
        key: slotKey(slotStart, slotEnd),
        dayKey: plainDateKey(date),
        dayLabel: formatDayLabel(slotStart, timeZone),
        label: formatTimeRange(slotStart, slotEnd, timeZone),
        startMs: slotStart,
        endMs: slotEnd,
      });
    }
  }

  return slots;
}

export function buildCustomerSlotDays(
  schedule: Pick<ScheduleHandle, "fields"> | { fields: Record<string, unknown> },
  sharedBookings: Array<Pick<BookingKeyRow, "fields">>,
  savedBookings: Array<Pick<SavedBookingHandle, "fields" | "id" | "ref">>,
  nowMs = Date.now(),
): SlotDay[] {
  const activeOwnedBookings = new Map<string, Pick<SavedBookingHandle, "fields" | "id" | "ref">>();
  for (const saved of savedBookings) {
    if (saved.fields.status !== "active") {
      continue;
    }

    activeOwnedBookings.set(slotKey(saved.fields.slotStartMs, saved.fields.slotEndMs), saved);
  }

  const sharedKeys = new Set(
    sharedBookings.map((booking) => slotKey(booking.fields.slotStartMs, booking.fields.slotEndMs)),
  );

  const grouped = new Map<string, SlotDay>();
  for (const occurrence of generateSlotOccurrences(schedule, nowMs)) {
    const ownedBooking = activeOwnedBookings.get(occurrence.key) ?? null;
    const status = ownedBooking
      ? "owned"
      : sharedKeys.has(occurrence.key)
        ? "taken"
        : "available";

    const existingDay = grouped.get(occurrence.dayKey) ?? {
      key: occurrence.dayKey,
      label: occurrence.dayLabel,
      slots: [],
    };

    existingDay.slots.push({
      ...occurrence,
      status,
      savedBooking: ownedBooking as SavedBookingHandle | null,
    });
    grouped.set(occurrence.dayKey, existingDay);
  }

  return Array.from(grouped.values());
}

export function buildOwnerBookingDays(
  schedule: Pick<ScheduleHandle, "fields"> | { fields: Record<string, unknown> },
  bookings: Array<Pick<BookingHandle, "id" | "owner" | "fields">>,
): OwnerBookingDay[] {
  const timeZone = String(schedule.fields.timezone ?? "UTC");
  const grouped = new Map<string, OwnerBookingDay>();

  for (const booking of bookings) {
    const startMs = booking.fields.slotStartMs;
    const endMs = booking.fields.slotEndMs;
    const day = getZonedDateTime(startMs, timeZone);
    const dayKey = plainDateKey({
      year: day.year,
      month: day.month,
      day: day.day,
    });
    const label = formatTimeRange(startMs, endMs, timeZone);
    const dayLabel = formatDayLabel(startMs, timeZone);
    const existing = grouped.get(dayKey) ?? {
      key: dayKey,
      label: dayLabel,
      entries: [],
    };

    existing.entries.push({
      id: booking.id,
      owner: booking.owner,
      dayKey,
      dayLabel,
      label,
    });
    grouped.set(dayKey, existing);
  }

  const days = Array.from(grouped.values());
  for (const day of days) {
    day.entries.sort((left, right) => left.label.localeCompare(right.label));
  }

  days.sort((left, right) => left.key.localeCompare(right.key));
  return days;
}

export class AppointmentService {
  constructor(private readonly db: AppointmentDbPort) {}

  createDraftFromSchedule(schedule: ScheduleHandle): ScheduleDraft {
    return scheduleFieldsToDraft(schedule.fields);
  }

  async rememberRecentSchedule(schedule: ScheduleHandle): Promise<void> {
    const existing = await this.db.query("recentSchedules", {
      in: CURRENT_USER,
      where: { scheduleRef: schedule.ref },
      orderBy: "openedAt",
      order: "desc",
      limit: 1,
    });
    const now = Date.now();
    const current = existing.find((recentSchedule) => sameRef(recentSchedule.fields.scheduleRef, schedule.ref)) ?? null;

    if (current) {
      await this.db.update("recentSchedules", current.ref, { openedAt: now }).committed;
      return;
    }

    await this.db.create("recentSchedules", {
      scheduleRef: schedule.ref,
      openedAt: now,
    }, {
      in: CURRENT_USER,
    }).committed;
  }

  async openRecentSchedule(recentSchedule: RecentScheduleHandle): Promise<ScheduleHandle> {
    const schedule = await this.db.getRow(recentSchedule.fields.scheduleRef);
    if (schedule.collection !== "schedules") {
      throw new Error(`Expected schedules row, got ${schedule.collection}`);
    }

    await this.rememberRecentSchedule(schedule);
    return schedule;
  }

  async createSchedule(draft: ScheduleDraft): Promise<ScheduleHandle> {
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      throw new Error(validationError);
    }

    const bookingRootWrite = this.db.create("bookingRoots", { createdAt: Date.now() });
    const bookingRoot = bookingRootWrite.value;
    await bookingRootWrite.committed;

    const bookingSubmitterLink = await this.db.createShareLink(bookingRoot.ref, "submitter").committed;
    const scheduleWrite = this.db.create("schedules", {
      ...draftToScheduleFields(draft),
      bookingSubmitterLink,
    });
    const schedule = scheduleWrite.value;
    await scheduleWrite.committed;
    await this.rememberRecentSchedule(schedule);
    return schedule;
  }

  async updateSchedule(schedule: ScheduleHandle, draft: ScheduleDraft): Promise<ScheduleHandle> {
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      throw new Error(validationError);
    }

    const updatedWrite = this.db.update("schedules", schedule.ref, draftToScheduleFields(draft));
    return updatedWrite.committed;
  }

  getBookingRootRef(schedule: ScheduleHandle): BookingRootRef {
    const parsed = this.db.parseInvite(schedule.fields.bookingSubmitterLink);
    if (parsed.ref.collection !== "bookingRoots") {
      throw new Error(`Expected bookingRoots ref, got ${parsed.ref.collection}`);
    }

    return parsed.ref as BookingRootRef;
  }

  async ensureBookingRootAccess(schedule: ScheduleHandle): Promise<BookingRootRef> {
    const joined = await this.db.joinInvite(schedule.fields.bookingSubmitterLink);
    if (joined.ref.collection !== "bookingRoots") {
      throw new Error(`Expected bookingRoots ref, got ${joined.ref.collection}`);
    }

    return joined.ref as BookingRootRef;
  }

  async bookSlot(args: {
    schedule: ScheduleHandle;
    bookingRootRef: BookingRootRef;
    slotStartMs: number;
    slotEndMs: number;
  }): Promise<BookingHandle> {
    const existing = await this.db.query("bookings", {
      in: args.bookingRootRef,
      where: {
        slotStartMs: args.slotStartMs,
        slotEndMs: args.slotEndMs,
      },
      select: "keys",
      limit: 1,
    });
    if (existing.length > 0) {
      throw new Error("This slot is no longer available.");
    }

    const bookingWrite = this.db.create("bookings", {
      slotStartMs: args.slotStartMs,
      slotEndMs: args.slotEndMs,
      createdAt: Date.now(),
    }, {
      in: args.bookingRootRef,
    });
    const booking = bookingWrite.value;
    await bookingWrite.committed;

    await this.db.create("savedBookings", {
      scheduleRef: args.schedule.ref,
      bookingRef: booking.ref,
      status: "active",
      slotStartMs: args.slotStartMs,
      slotEndMs: args.slotEndMs,
    }, {
      in: CURRENT_USER,
    }).committed;

    return booking;
  }

  async cancelSavedBooking(args: {
    savedBooking: SavedBookingHandle;
    bookingRootRef: BookingRootRef;
  }): Promise<void> {
    const booking = await this.db.getRow(args.savedBooking.fields.bookingRef);
    if (booking.collection !== "bookings") {
      throw new Error(`Expected bookings row, got ${booking.collection}`);
    }

    await booking.in.remove(args.bookingRootRef).committed;
    await this.db.update("savedBookings", args.savedBooking.ref, { status: "canceled" }).committed;
  }
}
