import { describe, expect, it, vi } from "vitest";

import { AppointmentService, buildCustomerSlotDays, createInitialDraft, generateSlotOccurrences } from "../src/service";
import type { BookingHandle, SavedBookingHandle, ScheduleHandle } from "../src/schema";

function settledReceipt<T>(value: T) {
  return {
    value,
    committed: Promise.resolve(value),
    status: "committed" as const,
    error: undefined,
  };
}

function makeRef<TCollection extends string>(id: string, collection: TCollection) {
  return {
    id,
    collection,
    baseUrl: "https://alice-apphash-v1-federation.puter.site",
  };
}

function makeSchedule(fields: Partial<ScheduleHandle["fields"]> = {}): ScheduleHandle {
  return {
    id: "schedule_1",
    collection: "schedules",
    owner: "alice",
    ref: makeRef("schedule_1", "schedules"),
    fields: {
      title: "Appointments",
      timezone: "UTC",
      slotDurationMinutes: 30,
      bookingSubmitterLink: "invite://booking-root",
      mondayStart: "09:00",
      mondayEnd: "11:00",
      tuesdayStart: undefined,
      tuesdayEnd: undefined,
      wednesdayStart: undefined,
      wednesdayEnd: undefined,
      thursdayStart: undefined,
      thursdayEnd: undefined,
      fridayStart: undefined,
      fridayEnd: undefined,
      saturdayStart: undefined,
      saturdayEnd: undefined,
      sundayStart: undefined,
      sundayEnd: undefined,
      ...fields,
    },
    in: {
      add: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
    },
    members: {
      add: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
      effective: vi.fn(),
      listAll: vi.fn(),
    },
    connectCrdt: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ScheduleHandle;
}

describe("slot generation", () => {
  it("produces slots for open days and skips closed ones", () => {
    const schedule = makeSchedule({
      mondayStart: "09:00",
      mondayEnd: "10:00",
      tuesdayStart: undefined,
      tuesdayEnd: undefined,
    });
    const nowMs = Date.UTC(2026, 2, 30, 8, 0, 0);

    const slots = generateSlotOccurrences(schedule, nowMs);

    expect(slots.some((slot) => slot.dayLabel.includes("Monday"))).toBe(true);
    expect(slots.some((slot) => slot.dayLabel.includes("Tuesday"))).toBe(false);
    expect(slots[0]?.label).toBe("9:00 AM - 9:30 AM");
  });

  it("excludes past slots and limits generation to fourteen days", () => {
    const schedule = makeSchedule({
      mondayStart: "09:00",
      mondayEnd: "10:00",
    });
    const nowMs = Date.UTC(2026, 2, 30, 9, 15, 0);

    const slots = generateSlotOccurrences(schedule, nowMs);

    expect(slots[0]?.label).toBe("9:30 AM - 10:00 AM");
    const latestStart = Math.max(...slots.map((slot) => slot.startMs));
    expect(latestStart - nowMs).toBeLessThan(14 * 24 * 60 * 60 * 1000);
  });
});

describe("booking state", () => {
  it("marks shared bookings as taken and active saved bookings as owned", () => {
    const schedule = makeSchedule();
    const nowMs = Date.UTC(2026, 2, 30, 8, 0, 0);
    const slots = generateSlotOccurrences(schedule, nowMs);
    const ownedSlot = slots[0];
    const takenSlot = slots[1];

    const slotDays = buildCustomerSlotDays(
      schedule,
      [
        {
          fields: {
            slotStartMs: ownedSlot.startMs,
            slotEndMs: ownedSlot.endMs,
          },
        },
        {
          fields: {
            slotStartMs: takenSlot.startMs,
            slotEndMs: takenSlot.endMs,
          },
        },
      ],
      [
        {
          id: "saved_1",
          ref: makeRef("saved_1", "savedBookings"),
          fields: {
            scheduleRef: schedule.ref,
            bookingRef: makeRef("booking_1", "bookings"),
            status: "active",
            slotStartMs: ownedSlot.startMs,
            slotEndMs: ownedSlot.endMs,
          },
        },
      ] as Array<Pick<SavedBookingHandle, "fields" | "id" | "ref">>,
      nowMs,
    );

    const flattened = slotDays.flatMap((day) => day.slots);
    expect(flattened.find((slot) => slot.key === ownedSlot.key)?.status).toBe("owned");
    expect(flattened.find((slot) => slot.key === takenSlot.key)?.status).toBe("taken");
  });
});

describe("service flows", () => {
  it("creates a booking root, submission link, schedule, and recent record in order", async () => {
    const events: string[] = [];
    const bookingRoot = {
      ref: makeRef("root_1", "bookingRoots"),
      id: "root_1",
      collection: "bookingRoots",
      owner: "alice",
      fields: { createdAt: 1 },
    } as unknown as BookingHandle;
    const schedule = makeSchedule();
    const service = new AppointmentService({
      create: vi.fn((collection: string) => {
        events.push(`create:${collection}`);
        if (collection === "bookingRoots") {
          return settledReceipt(bookingRoot);
        }

        if (collection === "schedules") {
          return settledReceipt(schedule);
        }

        return settledReceipt({
          id: "recent_1",
          ref: makeRef("recent_1", "recentSchedules"),
          collection: "recentSchedules",
          owner: "alice",
          fields: {
            scheduleRef: schedule.ref,
            openedAt: 1,
          },
        });
      }),
      createSubmissionLink: vi.fn(() => {
        events.push("submission-link");
        return settledReceipt("invite://booking-root");
      }),
      getRow: vi.fn(),
      joinInvite: vi.fn(),
      parseInvite: vi.fn(),
      query: vi.fn(async () => {
        events.push("query:recentSchedules");
        return [];
      }),
      update: vi.fn(),
    } as never);

    await service.createSchedule(createInitialDraft("UTC"));

    expect(events).toEqual([
      "create:bookingRoots",
      "submission-link",
      "create:schedules",
      "query:recentSchedules",
      "create:recentSchedules",
    ]);
  });

  it("creates both shared and private booking records when reserving a slot", async () => {
    const booking = {
      id: "booking_1",
      ref: makeRef("booking_1", "bookings"),
      collection: "bookings",
      owner: "bob",
      fields: {
        slotStartMs: 1,
        slotEndMs: 2,
        createdAt: 3,
      },
    } as unknown as BookingHandle;
    const create = vi.fn((collection: string) => {
      if (collection === "bookings") {
        return settledReceipt(booking);
      }

      return settledReceipt({
        id: "saved_1",
        ref: makeRef("saved_1", "savedBookings"),
        collection: "savedBookings",
        owner: "bob",
        fields: {},
      });
    });
    const query = vi.fn(async () => []);
    const service = new AppointmentService({
      create,
      createSubmissionLink: vi.fn(),
      getRow: vi.fn(),
      joinInvite: vi.fn(),
      parseInvite: vi.fn(),
      query,
      update: vi.fn(),
    } as never);

    await service.bookSlot({
      schedule: makeSchedule(),
      bookingRootRef: makeRef("root_1", "bookingRoots"),
      slotStartMs: 1,
      slotEndMs: 2,
    });

    expect(query).toHaveBeenCalled();
    expect(create).toHaveBeenNthCalledWith(1, "bookings", expect.objectContaining({
      slotStartMs: 1,
      slotEndMs: 2,
    }), {
      in: makeRef("root_1", "bookingRoots"),
    });
    expect(create).toHaveBeenNthCalledWith(2, "savedBookings", expect.objectContaining({
      slotStartMs: 1,
      slotEndMs: 2,
      status: "active",
    }));
  });

  it("unlinks the shared booking and marks the private record canceled", async () => {
    const removeReceipt = settledReceipt(undefined);
    const remove = vi.fn(() => removeReceipt);
    const update = vi.fn(() => settledReceipt({
      id: "saved_1",
      ref: makeRef("saved_1", "savedBookings"),
      collection: "savedBookings",
      owner: "bob",
      fields: {
        status: "canceled",
      },
    }));
    const service = new AppointmentService({
      create: vi.fn(),
      createSubmissionLink: vi.fn(),
      getRow: vi.fn(async () => ({
        id: "booking_1",
        ref: makeRef("booking_1", "bookings"),
        collection: "bookings",
        owner: "bob",
        fields: {
          slotStartMs: 1,
          slotEndMs: 2,
          createdAt: 3,
        },
        in: {
          add: vi.fn(),
          remove,
          list: vi.fn(),
        },
        members: {
          add: vi.fn(),
          remove: vi.fn(),
          list: vi.fn(),
          effective: vi.fn(),
          listAll: vi.fn(),
        },
        connectCrdt: vi.fn(),
        refresh: vi.fn(),
      }) as unknown as BookingHandle),
      joinInvite: vi.fn(),
      parseInvite: vi.fn(),
      query: vi.fn(),
      update,
    } as never);

    const savedBooking = {
      id: "saved_1",
      ref: makeRef("saved_1", "savedBookings"),
      collection: "savedBookings",
      owner: "bob",
      fields: {
        scheduleRef: makeRef("schedule_1", "schedules"),
        bookingRef: makeRef("booking_1", "bookings"),
        status: "active",
        slotStartMs: 1,
        slotEndMs: 2,
      },
    } as unknown as SavedBookingHandle;

    await service.cancelSavedBooking({
      savedBooking,
      bookingRootRef: makeRef("root_1", "bookingRoots"),
    });

    expect(remove).toHaveBeenCalledWith(makeRef("root_1", "bookingRoots"));
    expect(update).toHaveBeenCalledWith("savedBookings", savedBooking.ref, {
      status: "canceled",
    });
  });
});
