import { CURRENT_USER } from "@vennbase/core";
import { useAcceptInviteFromUrl, useMutation, useQuery, useRow, useSession, useShareLink, useVennbase } from "@vennbase/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { service } from "./db";
import {
  BOOKING_COOLOFF_MS,
  buildCustomerSlotDays,
  buildOwnerBookingDays,
  createInitialDraft,
} from "./service";
import {
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  type ScheduleDraft,
} from "./schedule";
import type {
  BookingHandle,
  BookingRootRef,
  RecentScheduleHandle,
  ScheduleHandle,
  ScheduleUserHandle,
  Schema,
} from "./schema";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function logAppError(context: string, error: unknown, details?: Record<string, unknown>): void {
  console.error(`[appointment-app] ${context}`, {
    error,
    ...(details ?? {}),
  });
}

function copyToClipboard(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

function useNow(tickMs = 1_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowMs(Date.now());
    }, tickMs);

    return () => {
      window.clearInterval(handle);
    };
  }, [tickMs]);

  return nowMs;
}

export default function App() {
  const db = useVennbase<Schema>();
  const session = useSession(db);
  const [schedule, setSchedule] = useState<ScheduleHandle | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading">("idle");

  const signedIn = session.status === "success" && session.data?.signedIn === true;
  const invite = useAcceptInviteFromUrl<Schema, ScheduleHandle>(db, {
    enabled: schedule === null,
    onOpen: async (nextSchedule) => {
      await service.rememberRecentSchedule(nextSchedule);
      setSchedule(nextSchedule);
    },
  });
  const invitePresent = invite.invitePhase !== "none";
  const inviteLoading = invite.invitePhase === "waiting" || invite.invitePhase === "accepting";

  if (!signedIn) {
    return (
      <MainLayout>
        <section className="card">
          <span className="eyebrow">Appointment booking</span>
          <h1>{invitePresent ? "Log in to book" : "Create a schedule"}</h1>
          <p className="muted">
            {invitePresent
              ? "Sign in with Puter to open this schedule and reserve a slot."
              : "Sign in with Puter before creating or sharing a booking schedule."}
          </p>
          <button
            className="primary"
            type="button"
            disabled={session.status === "loading" || loginStatus === "loading"}
            onClick={() => {
              setLoginError("");
              setLoginStatus("loading");
              void session.signIn()
                .catch((error) => {
                  logAppError("sign in failed", error);
                  setLoginError(getErrorMessage(error, "Sign-in failed."));
                })
                .finally(() => {
                  setLoginStatus("idle");
                });
            }}
          >
            {session.status === "loading" || loginStatus === "loading"
              ? "Opening Puter..."
              : invitePresent
                ? "Log in to book"
                : "Log in with Puter"}
          </button>
          {loginError ? <p className="error">{loginError}</p> : null}
        </section>
      </MainLayout>
    );
  }

  if (schedule) {
    return <ScheduleScreen schedule={schedule} onLeave={() => setSchedule(null)} />;
  }

  if (inviteLoading) {
    return (
      <MainLayout>
        <section className="card">
          <span className="eyebrow">Opening</span>
          <h1>Opening shared schedule</h1>
          <p className="muted">Joining the invite and loading the schedule...</p>
        </section>
      </MainLayout>
    );
  }

  const inviteErrorMessage = invite.invitePhase === "error"
    ? getErrorMessage(invite.error, "Failed to open share link.")
    : "";

  return <LandingView errorMessage={inviteErrorMessage} onSchedule={setSchedule} />;
}

function MainLayout(props: { children: ReactNode }) {
  return (
    <main className="shell">
      {props.children}
    </main>
  );
}

function LandingView(props: {
  errorMessage: string;
  onSchedule(nextSchedule: ScheduleHandle): void;
}) {
  const db = useVennbase<Schema>();
  const [draft, setDraft] = useState(() => createInitialDraft());
  const createSchedule = useMutation(async (nextDraft: ScheduleDraft) => service.createSchedule(nextDraft));
  const openRecent = useMutation(async (recentSchedule: RecentScheduleHandle) => service.openRecentSchedule(recentSchedule));

  const {
    rows: recentSchedules = [],
    error: recentSchedulesError,
  } = useQuery(db, "recentSchedules", {
    in: CURRENT_USER,
    orderBy: "openedAt",
    order: "desc",
    limit: 100,
  });
  const visibleRecentSchedules = useMemo(() => {
    const deduped = new Map<string, RecentScheduleHandle>();

    for (const recentSchedule of [...recentSchedules].sort((left, right) => right.fields.openedAt - left.fields.openedAt)) {
      const key = `${recentSchedule.fields.scheduleRef.baseUrl}:${recentSchedule.fields.scheduleRef.id}`;
      if (!deduped.has(key)) {
        deduped.set(key, recentSchedule);
      }
    }

    return Array.from(deduped.values()).slice(0, 10);
  }, [recentSchedules]);

  return (
    <MainLayout>
      <section className="card">
        <span className="eyebrow">Appointment booking</span>
        <h1>Publish a simple booking page</h1>
        <p className="muted">
          Define one availability window per weekday, choose a slot duration, then share a customer link.
        </p>
        <ScheduleEditor
          draft={draft}
          submitLabel={createSchedule.status === "loading" ? "Creating..." : "Create schedule"}
          disabled={createSchedule.status === "loading"}
          errorMessage={createSchedule.error ? getErrorMessage(createSchedule.error, "Could not create schedule.") : props.errorMessage}
          onChange={setDraft}
          onSubmit={() => {
            void createSchedule.mutate(draft)
              .then((nextSchedule) => {
                props.onSchedule(nextSchedule);
              })
              .catch((error) => {
                logAppError("create schedule failed", error, {
                  timezone: draft.timezone,
                  title: draft.title,
                });
              });
          }}
        />
      </section>

      {visibleRecentSchedules.length > 0 ? (
        <section className="card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Recent</span>
              <h2>Open an existing schedule</h2>
            </div>
          </div>
          <ul className="list">
            {visibleRecentSchedules.map((recentSchedule) => (
              <RecentScheduleListItem
                key={recentSchedule.id}
                recentSchedule={recentSchedule}
                onOpen={(row) => {
                  void openRecent.mutate(row)
                    .then((schedule) => {
                      props.onSchedule(schedule);
                    })
                    .catch((error) => {
                      logAppError("open recent schedule failed", error, {
                        recentScheduleId: row.id,
                      });
                    });
                }}
              />
            ))}
          </ul>
          {openRecent.error ? <p className="error">{getErrorMessage(openRecent.error, "Could not open schedule.")}</p> : null}
          {recentSchedulesError ? <p className="error">{getErrorMessage(recentSchedulesError, "Could not load recent schedules.")}</p> : null}
        </section>
      ) : null}
    </MainLayout>
  );
}

function RecentScheduleListItem(props: {
  recentSchedule: RecentScheduleHandle;
  onOpen(recentSchedule: RecentScheduleHandle): void;
}) {
  const db = useVennbase<Schema>();
  const schedule = useRow(db, props.recentSchedule.fields.scheduleRef);
  const label = schedule.status === "success" && schedule.data
    ? schedule.data.fields.title
    : schedule.status === "error"
      ? "Unavailable schedule"
      : "Loading schedule...";

  return (
    <li className="list-item">
      <button
        className="secondary small"
        type="button"
        onClick={() => props.onOpen(props.recentSchedule)}
      >
        Open
      </button>
      <span>{label}</span>
    </li>
  );
}

function ScheduleScreen(props: {
  schedule: ScheduleHandle;
  onLeave(): void;
}) {
  const db = useVennbase<Schema>();
  const session = useSession(db);
  const liveScheduleResult = useRow(db, props.schedule);
  const schedule = liveScheduleResult.status === "success" && liveScheduleResult.data
    ? liveScheduleResult.data
    : props.schedule;
  const signedInUser =
    session.status === "success" && session.data?.signedIn
      ? session.data.user
      : null;
  const isOwner = signedInUser?.username === schedule.owner;
  const [bookingRootRef, setBookingRootRef] = useState<BookingRootRef | null>(null);
  const [scheduleUser, setScheduleUser] = useState<ScheduleUserHandle | null>(null);
  const [rootStatus, setRootStatus] = useState<"loading" | "ready" | "error">("loading");
  const [rootError, setRootError] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (isOwner) {
      try {
        const nextRef = service.getBookingRootRef(schedule);
        if (!cancelled) {
          setBookingRootRef(nextRef);
          setScheduleUser(null);
          setRootStatus("ready");
          setRootError("");
        }
      } catch (error) {
        logAppError("resolve owner booking root failed", error, {
          scheduleId: schedule.id,
        });
        if (!cancelled) {
          setRootStatus("error");
          setRootError(getErrorMessage(error, "Could not resolve booking inbox."));
        }
      }
      return () => {
        cancelled = true;
      };
    }

    setRootStatus("loading");
    setRootError("");
    setBookingRootRef(null);
    setScheduleUser(null);

    void Promise.all([
      service.ensureBookingRootAccess(schedule),
      service.ensureScheduleUserRow(schedule),
    ])
      .then(([nextRef, nextScheduleUser]) => {
        if (cancelled) {
          return;
        }

        setBookingRootRef(nextRef);
        setScheduleUser(nextScheduleUser);
        setRootStatus("ready");
      })
      .catch((error) => {
        logAppError("join booking root failed", error, {
          scheduleId: schedule.id,
        });
        if (cancelled) {
          return;
        }

        setRootStatus("error");
        setRootError(getErrorMessage(error, "Could not join the booking inbox."));
      });

    return () => {
      cancelled = true;
    };
  }, [isOwner, schedule]);

  return (
    <MainLayout>
      <section className="card">
        <div className="toolbar">
          <div>
            <span className="eyebrow">{isOwner ? "Owner" : "Customer"}</span>
            <h1>{schedule.fields.title}</h1>
            <p className="muted">
              Timezone: <strong>{schedule.fields.timezone}</strong>
            </p>
          </div>
          <button className="secondary small" type="button" onClick={props.onLeave}>
            Back
          </button>
        </div>
      </section>

      {rootStatus === "loading" ? (
        <section className="card">
          <h2>Preparing bookings</h2>
          <p className="muted">
            {isOwner ? "Loading your booking inbox..." : "Joining the booking inbox for this schedule..."}
          </p>
        </section>
      ) : null}

      {rootStatus === "error" ? (
        <section className="card">
          <h2>Could not open bookings</h2>
          <p className="error">{rootError}</p>
        </section>
      ) : null}

      {rootStatus === "ready" && bookingRootRef
        ? isOwner
          ? <OwnerScheduleView bookingRootRef={bookingRootRef} schedule={schedule} />
          : scheduleUser
            ? <CustomerScheduleView bookingRootRef={bookingRootRef} schedule={schedule} scheduleUser={scheduleUser} />
            : null
        : null}
    </MainLayout>
  );
}

function OwnerScheduleView(props: {
  schedule: ScheduleHandle;
  bookingRootRef: BookingRootRef;
}) {
  const db = useVennbase<Schema>();
  const nowMs = useNow();
  const [draft, setDraft] = useState(() => service.createDraftFromSchedule(props.schedule));
  const [copyStatus, setCopyStatus] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [repeatStatus, setRepeatStatus] = useState("");
  const shareLink = useShareLink(db, props.schedule, "content-submitter");
  const {
    rows: bookings = [],
    error: bookingsError,
  } = useQuery(db, "bookings", {
    in: props.bookingRootRef,
    limit: 500,
  });

  useEffect(() => {
    setDraft(service.createDraftFromSchedule(props.schedule));
  }, [props.schedule.fields]);

  const groupedBookings = useMemo(
    () => buildOwnerBookingDays(props.schedule, bookings as BookingHandle[], nowMs),
    [bookings, nowMs, props.schedule],
  );

  return (
    <>
      <section className="card">
        <div className="section-header">
          <div>
            <span className="eyebrow">Configuration</span>
            <h2>Edit availability</h2>
          </div>
        </div>
        <ScheduleEditor
          draft={draft}
          disabled={false}
          submitLabel="Save schedule"
          errorMessage={updateError}
          onChange={setDraft}
          onSubmit={() => {
            try {
              service.updateSchedule(props.schedule, draft);
              setUpdateError("");
              setCopyStatus("");
            } catch (error) {
              logAppError("update schedule failed", error, {
                scheduleId: props.schedule.id,
              });
              setUpdateError(getErrorMessage(error, "Could not save schedule."));
            }
          }}
        />
      </section>

      <section className="card">
        <div className="section-header">
          <div>
            <span className="eyebrow">Sharing</span>
            <h2>Customer link</h2>
          </div>
        </div>
        <div className="share-row">
          <a className="share-link" href={shareLink.shareLink ?? "#"}>
            {shareLink.shareLink ?? "Generating share link..."}
          </a>
          <button
            className="secondary"
            type="button"
            disabled={!shareLink.shareLink}
            onClick={() => {
              if (!shareLink.shareLink) {
                return;
              }

              void copyToClipboard(shareLink.shareLink)
                .then(() => {
                  setCopyStatus("Customer link copied.");
                })
                .catch((error) => {
                  logAppError("copy customer link failed", error, {
                    scheduleId: props.schedule.id,
                  });
                  setCopyStatus("Could not copy the customer link.");
                });
            }}
          >
            Copy link
          </button>
        </div>
        <p className="muted">{copyStatus || (shareLink.error ? getErrorMessage(shareLink.error, "Could not create share link.") : "Share this content-submitter link with customers.")}</p>
      </section>

      <section className="card">
        <div className="section-header">
          <div>
            <span className="eyebrow">Bookings</span>
            <h2>Customer reservations</h2>
          </div>
        </div>
        {groupedBookings.length === 0 ? (
          <p className="muted">No bookings yet.</p>
        ) : (
          <div className="day-stack">
            {groupedBookings.map((day) => (
              <div key={day.key} className="day-block">
                <h3>{day.label}</h3>
                <ul className="list">
                  {day.entries.map((entry) => (
                    <li key={entry.id} className="list-item booking-item">
                      <span>{entry.label}</span>
                      <span className="booking-owner">
                        @{entry.customerUsername} {entry.status === "pending" ? "(pending)" : ""}
                      </span>
                      <button
                        className="secondary small"
                        type="button"
                        onClick={() => {
                          setRepeatStatus("");
                          try {
                            service.repeatBookingOneWeekLater({
                              booking: entry.booking,
                              bookingRootRef: props.bookingRootRef,
                            });
                            setRepeatStatus(`Repeated ${entry.label} for next week.`);
                          } catch (error) {
                            logAppError("repeat booking failed", error, {
                              bookingId: entry.booking.id,
                              scheduleId: props.schedule.id,
                            });
                            setRepeatStatus(getErrorMessage(error, "Could not repeat booking."));
                          }
                        }}
                      >
                        Repeat next week
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {repeatStatus ? <p className={repeatStatus.includes("Could not") ? "error" : "muted"}>{repeatStatus}</p> : null}
        {bookingsError ? <p className="error">{getErrorMessage(bookingsError, "Could not load bookings.")}</p> : null}
      </section>
    </>
  );
}

function CustomerScheduleView(props: {
  schedule: ScheduleHandle;
  bookingRootRef: BookingRootRef;
  scheduleUser: ScheduleUserHandle;
}) {
  const db = useVennbase<Schema>();
  const nowMs = useNow();
  const [actionMessage, setActionMessage] = useState("");
  const {
    rows: sharedBookings = [],
    error: sharedBookingsError,
  } = useQuery(db, "bookings", {
    in: props.bookingRootRef,
    select: "indexKeys",
    limit: 500,
  });
  const {
    rows: customerBookings = [],
    error: customerBookingsError,
  } = useQuery(db, "bookings", {
    in: props.scheduleUser,
    limit: 500,
  });

  const slotDays = useMemo(
    () => buildCustomerSlotDays(props.schedule, sharedBookings, customerBookings as BookingHandle[], nowMs),
    [customerBookings, nowMs, props.schedule, sharedBookings],
  );

  return (
    <section className="card">
      <div className="section-header">
        <div>
          <span className="eyebrow">Booking</span>
          <h2>Choose a slot</h2>
        </div>
      </div>
      <p className="muted">
        Available slots are shown for the next 14 days. New claims stay pending for about {Math.round(BOOKING_COOLOFF_MS / 1_000)} seconds, then all clients agree on the earliest visible claim for that slot.
      </p>
      {slotDays.length === 0 ? (
        <p className="muted">No slots are available in the next 14 days.</p>
      ) : (
        <div className="day-stack">
          {slotDays.map((day) => (
            <div key={day.key} className="day-block">
              <h3>{day.label}</h3>
              <ul className="list">
                {day.slots.map((slot) => (
                  <li key={slot.key} className="list-item booking-item">
                    <span>{slot.label}</span>
                    {slot.status === "available" ? (
                      <button
                        className="primary small"
                        type="button"
                        onClick={() => {
                          setActionMessage("");
                          try {
                            service.bookSlot({
                              bookingRootRef: props.bookingRootRef,
                              scheduleUser: props.scheduleUser,
                              slotStartMs: slot.startMs,
                              slotEndMs: slot.endMs,
                            });
                            setActionMessage("Claim submitted. Waiting for confirmation.");
                          } catch (error) {
                            logAppError("book slot failed", error, {
                              scheduleId: props.schedule.id,
                              slotStartMs: slot.startMs,
                              slotEndMs: slot.endMs,
                            });
                            setActionMessage(getErrorMessage(error, "Could not book slot."));
                          }
                        }}
                      >
                        Book
                      </button>
                    ) : slot.booking ? (
                      <div className="slot-actions">
                        <span className="slot-status">
                          {slot.status === "pending"
                            ? "Pending"
                            : slot.status === "confirmed"
                              ? "Booked"
                              : "Not confirmed"}
                        </span>
                        <button
                          className="secondary small"
                          type="button"
                          onClick={() => {
                            setActionMessage("");
                            try {
                              service.cancelBooking({
                                booking: slot.booking!,
                                bookingRootRef: props.bookingRootRef,
                                scheduleUser: props.scheduleUser,
                              });
                              setActionMessage("Booking canceled.");
                            } catch (error) {
                              logAppError("cancel booking failed", error, {
                                scheduleId: props.schedule.id,
                                bookingId: slot.booking?.id ?? null,
                              });
                              setActionMessage(getErrorMessage(error, "Could not cancel booking."));
                            }
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className="slot-status">{slot.status === "pending" ? "Pending" : "Taken"}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {actionMessage ? <p className={actionMessage.includes("Could not") ? "error" : "muted"}>{actionMessage}</p> : null}
      {sharedBookingsError ? <p className="error">{getErrorMessage(sharedBookingsError, "Could not load bookings.")}</p> : null}
      {customerBookingsError ? <p className="error">{getErrorMessage(customerBookingsError, "Could not load your bookings.")}</p> : null}
    </section>
  );
}

function ScheduleEditor(props: {
  draft: ScheduleDraft;
  submitLabel: string;
  disabled: boolean;
  errorMessage: string;
  onChange(nextDraft: ScheduleDraft): void;
  onSubmit(): void;
}) {
  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="field-grid">
        <label>
          <span>Title</span>
          <input
            value={props.draft.title}
            onChange={(event) => {
              props.onChange({
                ...props.draft,
                title: event.target.value,
              });
            }}
            placeholder="Appointments"
            required
          />
        </label>
        <label>
          <span>Timezone</span>
          <input
            value={props.draft.timezone}
            onChange={(event) => {
              props.onChange({
                ...props.draft,
                timezone: event.target.value,
              });
            }}
            placeholder="America/Los_Angeles"
            required
          />
        </label>
        <label>
          <span>Slot duration (minutes)</span>
          <input
            value={props.draft.slotDurationMinutes}
            inputMode="numeric"
            onChange={(event) => {
              props.onChange({
                ...props.draft,
                slotDurationMinutes: event.target.value,
              });
            }}
            placeholder="30"
            required
          />
        </label>
      </div>

      <div className="availability-grid">
        <div className="availability-header">Day</div>
        <div className="availability-header">Start</div>
        <div className="availability-header">End</div>
        {WEEKDAY_KEYS.map((day) => (
          <AvailabilityRow
            key={day}
            day={day}
            draft={props.draft}
            onChange={props.onChange}
          />
        ))}
      </div>

      <button className="primary" type="submit" disabled={props.disabled}>
        {props.submitLabel}
      </button>
      {props.errorMessage ? <p className="error">{props.errorMessage}</p> : null}
    </form>
  );
}

function AvailabilityRow(props: {
  day: typeof WEEKDAY_KEYS[number];
  draft: ScheduleDraft;
  onChange(nextDraft: ScheduleDraft): void;
}) {
  const availability = props.draft.availability[props.day];

  return (
    <>
      <div className="availability-day">{WEEKDAY_LABELS[props.day]}</div>
      <input
        value={availability.start}
        onChange={(event) => {
          props.onChange({
            ...props.draft,
            availability: {
              ...props.draft.availability,
              [props.day]: {
                ...availability,
                start: event.target.value,
              },
            },
          });
        }}
        placeholder="09:00"
      />
      <input
        value={availability.end}
        onChange={(event) => {
          props.onChange({
            ...props.draft,
            availability: {
              ...props.draft.availability,
              [props.day]: {
                ...availability,
                end: event.target.value,
              },
            },
          });
        }}
        placeholder="17:00"
      />
    </>
  );
}
