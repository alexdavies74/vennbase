import { Vennbase, RowHandle, collection, defineSchema, field, type DbAnonymousProjection, type InsertFields, type RowRef } from "@vennbase/core";

export const schema = defineSchema({
  schedules: collection({
    fields: {
      title: field.string(),
      timezone: field.string(),
      slotDurationMinutes: field.number(),
      bookingSubmitterLink: field.string(),
      mondayStart: field.string().optional(),
      mondayEnd: field.string().optional(),
      tuesdayStart: field.string().optional(),
      tuesdayEnd: field.string().optional(),
      wednesdayStart: field.string().optional(),
      wednesdayEnd: field.string().optional(),
      thursdayStart: field.string().optional(),
      thursdayEnd: field.string().optional(),
      fridayStart: field.string().optional(),
      fridayEnd: field.string().optional(),
      saturdayStart: field.string().optional(),
      saturdayEnd: field.string().optional(),
      sundayStart: field.string().optional(),
      sundayEnd: field.string().optional(),
    },
  }),
  bookingRoots: collection({
    fields: {
      createdAt: field.number().key(),
    },
  }),
  bookings: collection({
    in: ["bookingRoots"],
    fields: {
      slotStartMs: field.number().key(),
      slotEndMs: field.number().key(),
      claimedAtMs: field.number().key(),
    },
  }),
  recentSchedules: collection({
    in: ["user"],
    fields: {
      scheduleRef: field.ref("schedules").key(),
      openedAt: field.number().key(),
    },
  }),
  savedBookings: collection({
    in: ["user"],
    fields: {
      scheduleRef: field.ref("schedules").key(),
      bookingRef: field.ref("bookings"),
      status: field.string().key(),
      slotStartMs: field.number().key(),
      slotEndMs: field.number().key(),
    },
  }),
});

export type Schema = typeof schema;
export type AppointmentDb = Vennbase<Schema>;
export type ScheduleHandle = RowHandle<Schema, "schedules">;
export type BookingRootHandle = RowHandle<Schema, "bookingRoots">;
export type BookingHandle = RowHandle<Schema, "bookings">;
export type RecentScheduleHandle = RowHandle<Schema, "recentSchedules">;
export type SavedBookingHandle = RowHandle<Schema, "savedBookings">;
export type BookingAnonymousProjection = DbAnonymousProjection<Schema, "bookings">;
export type BookingRootRef = RowRef<"bookingRoots">;
export type ScheduleInsertFields = InsertFields<Schema, "schedules">;
export type EditableScheduleFields = Omit<ScheduleInsertFields, "bookingSubmitterLink">;
