import { CURRENT_USER, toRowRef, type RowTarget } from "@vennbase/core";
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
  BookingIndexKeyProjection,
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
  status: "available" | "pending" | "confirmed" | "superseded";
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
  status: "pending" | "confirmed";
}

export interface OwnerBookingDay {
  key: string;
  label: string;
  entries: OwnerBookingEntry[];
}

export const BOOKING_COOLOFF_MS = 5_000;

function slotKey(startMs: number, endMs: number): string {
  return `${startMs}:${endMs}`;
}

interface BookingClaim {
  id: string;
  slotStartMs: number;
  slotEndMs: number;
  claimedAtMs: number;
}

type BookingClaimSource = Pick<BookingIndexKeyProjection, "id" | "fields">
  | Pick<BookingHandle, "id" | "fields">;

function compareBookingClaims(left: BookingClaim, right: BookingClaim): number {
  if (left.claimedAtMs !== right.claimedAtMs) {
    return left.claimedAtMs - right.claimedAtMs;
  }

  return left.id.localeCompare(right.id);
}

function readBookingClaim(source: BookingClaimSource): BookingClaim {
  const values = source.fields;
  return {
    id: source.id,
    slotStartMs: values.slotStartMs,
    slotEndMs: values.slotEndMs,
    claimedAtMs: values.claimedAtMs,
  };
}

function groupBookingClaims(
  bookings: BookingClaimSource[],
): Map<string, BookingClaim[]> {
  const grouped = new Map<string, BookingClaim[]>();

  for (const booking of bookings) {
    const claim = readBookingClaim(booking);
    const key = slotKey(claim.slotStartMs, claim.slotEndMs);
    const claims = grouped.get(key) ?? [];
    claims.push(claim);
    grouped.set(key, claims);
  }

  for (const claims of grouped.values()) {
    claims.sort(compareBookingClaims);
  }

  return grouped;
}

function sameRef(
  left: RowTarget<"schedules">,
  right: RowTarget<"schedules">,
): boolean {
  const leftRef = toRowRef(left);
  const rightRef = toRowRef(right);
  return leftRef.id === rightRef.id
    && leftRef.collection === rightRef.collection
    && leftRef.baseUrl === rightRef.baseUrl;
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
  sharedBookings: Array<Pick<BookingIndexKeyProjection, "id" | "fields">>,
  savedBookings: Array<Pick<SavedBookingHandle, "fields" | "id" | "ref">>,
  nowMs = Date.now(),
): SlotDay[] {
  const activeOwnedBookings = new Map<string, Array<Pick<SavedBookingHandle, "fields" | "id" | "ref">>>();
  for (const saved of savedBookings) {
    if (saved.fields.status !== "active") {
      continue;
    }

    const key = slotKey(saved.fields.slotStartMs, saved.fields.slotEndMs);
    const claims = activeOwnedBookings.get(key) ?? [];
    claims.push(saved);
    activeOwnedBookings.set(key, claims);
  }

  const sharedClaimsBySlot = groupBookingClaims(sharedBookings);

  const grouped = new Map<string, SlotDay>();
  for (const occurrence of generateSlotOccurrences(schedule, nowMs)) {
    const ownedClaims = activeOwnedBookings.get(occurrence.key) ?? [];
    const winningClaim = sharedClaimsBySlot.get(occurrence.key)?.[0] ?? null;
    const matchingOwnedWinner = winningClaim
      ? ownedClaims.find((saved) => saved.fields.bookingRef.id === winningClaim.id) ?? null
      : null;
    const representativeOwnedClaim = matchingOwnedWinner ?? ownedClaims[0] ?? null;
    const status: CustomerSlot["status"] = !winningClaim
      ? representativeOwnedClaim
        ? "pending"
        : "available"
      : winningClaim.claimedAtMs + BOOKING_COOLOFF_MS > nowMs
        ? "pending"
        : matchingOwnedWinner
          ? "confirmed"
          : representativeOwnedClaim
            ? "superseded"
            : "confirmed";

    const existingDay = grouped.get(occurrence.dayKey) ?? {
      key: occurrence.dayKey,
      label: occurrence.dayLabel,
      slots: [],
    };

    existingDay.slots.push({
      ...occurrence,
      status,
      savedBooking: representativeOwnedClaim as SavedBookingHandle | null,
    });
    grouped.set(occurrence.dayKey, existingDay);
  }

  return Array.from(grouped.values());
}

export function buildOwnerBookingDays(
  schedule: Pick<ScheduleHandle, "fields"> | { fields: Record<string, unknown> },
  bookings: Array<Pick<BookingHandle, "id" | "owner" | "fields">>,
  nowMs = Date.now(),
): OwnerBookingDay[] {
  const timeZone = String(schedule.fields.timezone ?? "UTC");
  const claimWinners = groupBookingClaims(bookings);
  const grouped = new Map<string, OwnerBookingDay>();

  for (const booking of bookings) {
    const key = slotKey(booking.fields.slotStartMs, booking.fields.slotEndMs);
    const winningClaim = claimWinners.get(key)?.[0] ?? null;
    if (!winningClaim || winningClaim.id !== booking.id) {
      continue;
    }

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
      status: winningClaim.claimedAtMs + BOOKING_COOLOFF_MS > nowMs ? "pending" : "confirmed",
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
    const scheduleRef = toRowRef(schedule);
    const existing = await this.db.query("recentSchedules", {
      in: CURRENT_USER,
      where: { scheduleRef },
      orderBy: "openedAt",
      order: "desc",
      limit: 1,
    });
    const now = Date.now();
    const current = existing.find((recentSchedule) => sameRef(recentSchedule.fields.scheduleRef, schedule)) ?? null;

    if (current) {
      await this.db.update("recentSchedules", current, { openedAt: now }).committed;
      return;
    }

    await this.db.create("recentSchedules", {
      scheduleRef,
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
    const bookingSubmitterLinkWrite = this.db.createShareLink(bookingRoot, "submitter");
    const bookingSubmitterLink = bookingSubmitterLinkWrite.value;
    const scheduleWrite = this.db.create("schedules", {
      ...draftToScheduleFields(draft),
      bookingSubmitterLink,
    });
    const schedule = await scheduleWrite.committed;

    await bookingRootWrite.committed;
    await bookingSubmitterLinkWrite.committed;
    await this.rememberRecentSchedule(schedule);
    return schedule;
  }

  async updateSchedule(schedule: ScheduleHandle, draft: ScheduleDraft): Promise<ScheduleHandle> {
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      throw new Error(validationError);
    }

    const updatedWrite = this.db.update("schedules", schedule, draftToScheduleFields(draft));
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
    const bookingWrite = this.db.create("bookings", {
      slotStartMs: args.slotStartMs,
      slotEndMs: args.slotEndMs,
      claimedAtMs: Date.now(),
    }, {
      in: args.bookingRootRef,
    });
    const booking = bookingWrite.value;
    await bookingWrite.committed;

    const scheduleRef = toRowRef(args.schedule);
    const bookingRef = toRowRef(booking);
    await this.db.create("savedBookings", {
      scheduleRef,
      bookingRef,
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
    await this.db.update("savedBookings", args.savedBooking, { status: "canceled" }).committed;
  }
}
