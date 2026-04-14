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
  ScheduleHandle,
  ScheduleUserHandle,
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
  booking: BookingHandle | null;
}

export interface SlotDay {
  key: string;
  label: string;
  slots: CustomerSlot[];
}

export interface OwnerBookingEntry {
  id: string;
  customerUsername: string;
  dayKey: string;
  dayLabel: string;
  label: string;
  status: "pending" | "confirmed";
  booking: BookingHandle;
}

export interface OwnerBookingDay {
  key: string;
  label: string;
  entries: OwnerBookingEntry[];
}

export const BOOKING_COOLOFF_MS = 5_000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

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
  customerBookings: Array<Pick<BookingHandle, "fields" | "id" | "ref">>,
  nowMs = Date.now(),
): SlotDay[] {
  const ownedBookingsBySlot = new Map<string, Array<Pick<BookingHandle, "fields" | "id" | "ref">>>();
  for (const booking of customerBookings) {
    const key = slotKey(booking.fields.slotStartMs, booking.fields.slotEndMs);
    const claims = ownedBookingsBySlot.get(key) ?? [];
    claims.push(booking);
    ownedBookingsBySlot.set(key, claims);
  }

  for (const claims of ownedBookingsBySlot.values()) {
    claims.sort((left, right) => compareBookingClaims(readBookingClaim(left), readBookingClaim(right)));
  }

  const sharedClaimsBySlot = groupBookingClaims(sharedBookings);

  const grouped = new Map<string, SlotDay>();
  for (const occurrence of generateSlotOccurrences(schedule, nowMs)) {
    const ownedClaims = ownedBookingsBySlot.get(occurrence.key) ?? [];
    const winningClaim = sharedClaimsBySlot.get(occurrence.key)?.[0] ?? null;
    const matchingOwnedWinner = winningClaim
      ? ownedClaims.find((booking) => booking.id === winningClaim.id) ?? null
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
      booking: representativeOwnedClaim as BookingHandle | null,
    });
    grouped.set(occurrence.dayKey, existingDay);
  }

  return Array.from(grouped.values());
}

export function buildOwnerBookingDays(
  schedule: Pick<ScheduleHandle, "fields"> | { fields: Record<string, unknown> },
  bookings: Array<Pick<BookingHandle, "id" | "fields">>,
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
      customerUsername: booking.fields.customerUsername,
      dayKey,
      dayLabel,
      label,
      status: winningClaim.claimedAtMs + BOOKING_COOLOFF_MS > nowMs ? "pending" : "confirmed",
      booking: booking as BookingHandle,
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
      this.db.update("recentSchedules", current, { openedAt: now });
      return;
    }

    this.db.create("recentSchedules", { scheduleRef, openedAt: now }, { in: CURRENT_USER });
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
    const bookingSubmitterLinkWrite = this.db.createShareLink(bookingRoot, "index-submitter");
    const bookingSubmitterLink = bookingSubmitterLinkWrite.value;
    const scheduleWrite = this.db.create("schedules", {
      ...draftToScheduleFields(draft),
      bookingSubmitterLink,
    });
    const schedule = scheduleWrite.value;
    // The embedded link is future-valid immediately, so we can store it on the
    // schedule optimistically. Before returning the schedule to code that might
    // publish it, wait for the inbox row and invite token to exist remotely.
    await Promise.all([
      scheduleWrite.committed,
      bookingRootWrite.committed,
      bookingSubmitterLinkWrite.committed,
    ]);
    await this.rememberRecentSchedule(schedule);
    return schedule;
  }

  async updateSchedule(schedule: ScheduleHandle, draft: ScheduleDraft): Promise<ScheduleHandle> {
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      throw new Error(validationError);
    }

    return this.db.update("schedules", schedule, draftToScheduleFields(draft)).value;
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

  async ensureScheduleUserRow(schedule: ScheduleHandle): Promise<ScheduleUserHandle> {
    const [existing] = await this.db.query("scheduleUsers", {
      in: CURRENT_USER,
      where: { scheduleRef: schedule.ref },
      limit: 1,
    });
    if (existing) {
      return existing;
    }

    return this.db.create("scheduleUsers", {
      scheduleRef: schedule.ref,
      createdAt: Date.now(),
    }, {
      in: [schedule.ref, CURRENT_USER],
    }).value;
  }

  async bookSlot(args: {
    bookingRootRef: BookingRootRef;
    scheduleUser: ScheduleUserHandle;
    slotStartMs: number;
    slotEndMs: number;
  }): Promise<BookingHandle> {
    return this.db.create("bookings", {
      slotStartMs: args.slotStartMs,
      slotEndMs: args.slotEndMs,
      claimedAtMs: Date.now(),
      scheduleUserRef: toRowRef(args.scheduleUser),
      customerUsername: args.scheduleUser.owner,
    }, {
      in: [args.bookingRootRef, args.scheduleUser.ref],
    }).value;
  }

  async cancelBooking(args: {
    booking: BookingHandle;
    bookingRootRef: BookingRootRef;
    scheduleUser: ScheduleUserHandle;
  }): Promise<void> {
    await Promise.all([
      args.booking.in.remove(args.bookingRootRef).committed,
      args.booking.in.remove(args.scheduleUser.ref).committed,
    ]);
  }

  async repeatBookingOneWeekLater(args: {
    booking: BookingHandle;
    bookingRootRef: BookingRootRef;
  }): Promise<BookingHandle> {
    return this.db.create("bookings", {
      slotStartMs: args.booking.fields.slotStartMs + ONE_WEEK_MS,
      slotEndMs: args.booking.fields.slotEndMs + ONE_WEEK_MS,
      claimedAtMs: Date.now(),
      scheduleUserRef: args.booking.fields.scheduleUserRef,
      customerUsername: args.booking.fields.customerUsername,
    }, {
      in: [args.bookingRootRef, args.booking.fields.scheduleUserRef],
    }).value;
  }
}
