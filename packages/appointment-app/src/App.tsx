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
  SavedBookingHandle,
  ScheduleHandle,
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

  if (!signedIn) {
    return (
      <MainLayout>
        <section className="card">
          <span className="eyebrow">Appointment booking</span>
          <h1>{invite.hasInvite ? "Log in to book" : "Create a schedule"}</h1>
          <p className="muted">
            {invite.hasInvite
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
              : invite.hasInvite
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

  if (invite.hasInvite && invite.status !== "error") {
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

  const inviteErrorMessage = invite.status === "error"
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
  const liveScheduleResult = useRow(db, props.schedule.ref);
  const schedule = liveScheduleResult.status === "success" && liveScheduleResult.data
    ? liveScheduleResult.data
    : props.schedule;
  const signedInUser =
    session.status === "success" && session.data?.signedIn
      ? session.data.user
      : null;
  const isOwner = signedInUser?.username === schedule.owner;
  const [bookingRootRef, setBookingRootRef] = useState<BookingRootRef | null>(null);
  const [rootStatus, setRootStatus] = useState<"loading" | "ready" | "error">("loading");
  const [rootError, setRootError] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (isOwner) {
      try {
        const nextRef = service.getBookingRootRef(schedule);
        if (!cancelled) {
          setBookingRootRef(nextRef);
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

    void service.ensureBookingRootAccess(schedule)
      .then((nextRef) => {
        if (cancelled) {
          return;
        }

        setBookingRootRef(nextRef);
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
          : <CustomerScheduleView bookingRootRef={bookingRootRef} schedule={schedule} />
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
  const updateSchedule = useMutation(async (nextDraft: ScheduleDraft) => service.updateSchedule(props.schedule, nextDraft));
  const shareLink = useShareLink(db, props.schedule.ref, { role: "viewer" });
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
          disabled={updateSchedule.status === "loading"}
          submitLabel={updateSchedule.status === "loading" ? "Saving..." : "Save schedule"}
          errorMessage={updateSchedule.error ? getErrorMessage(updateSchedule.error, "Could not save schedule.") : ""}
          onChange={setDraft}
          onSubmit={() => {
            void updateSchedule.mutate(draft)
              .then(() => {
                setCopyStatus("");
              })
              .catch((error) => {
                logAppError("update schedule failed", error, {
                  scheduleId: props.schedule.id,
                });
              });
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
        <p className="muted">{copyStatus || (shareLink.error ? getErrorMessage(shareLink.error, "Could not create share link.") : "Share this viewer link with customers.")}</p>
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
                        @{entry.owner} {entry.status === "pending" ? "(pending)" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {bookingsError ? <p className="error">{getErrorMessage(bookingsError, "Could not load bookings.")}</p> : null}
      </section>
    </>
  );
}

function CustomerScheduleView(props: {
  schedule: ScheduleHandle;
  bookingRootRef: BookingRootRef;
}) {
  const db = useVennbase<Schema>();
  const nowMs = useNow();
  const [pendingAction, setPendingAction] = useState<{ key: string; type: "book" | "cancel" } | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const {
    rows: sharedBookings = [],
    error: sharedBookingsError,
  } = useQuery(db, "bookings", {
    in: props.bookingRootRef,
    select: "keys",
    limit: 500,
  });
  const {
    rows: savedBookings = [],
    error: savedBookingsError,
  } = useQuery(db, "savedBookings", {
    in: CURRENT_USER,
    where: { scheduleRef: props.schedule.ref },
    orderBy: "slotStartMs",
    order: "asc",
    limit: 500,
  });
  const visibleSavedBookings = useMemo(
    () =>
      savedBookings
        .filter((savedBooking) => savedBooking.fields.status === "active")
        .sort((left, right) => left.fields.slotStartMs - right.fields.slotStartMs),
    [savedBookings],
  );

  const reserve = useMutation(async (slot: { key: string; startMs: number; endMs: number }) => {
    await service.bookSlot({
      schedule: props.schedule,
      bookingRootRef: props.bookingRootRef,
      slotStartMs: slot.startMs,
      slotEndMs: slot.endMs,
    });
  });
  const cancel = useMutation(async (savedBooking: SavedBookingHandle) => {
    await service.cancelSavedBooking({
      savedBooking,
      bookingRootRef: props.bookingRootRef,
    });
  });

  const slotDays = useMemo(
    () => buildCustomerSlotDays(props.schedule, sharedBookings, visibleSavedBookings, nowMs),
    [nowMs, props.schedule, sharedBookings, visibleSavedBookings],
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
                        disabled={pendingAction?.key === slot.key}
                        onClick={() => {
                          setPendingAction({ key: slot.key, type: "book" });
                          setActionMessage("");
                          void reserve.mutate(slot)
                            .then(() => {
                              setActionMessage("Claim submitted. Waiting for confirmation.");
                            })
                            .catch((error) => {
                              logAppError("book slot failed", error, {
                                scheduleId: props.schedule.id,
                                slotStartMs: slot.startMs,
                                slotEndMs: slot.endMs,
                              });
                              setActionMessage(getErrorMessage(error, "Could not book slot."));
                            })
                            .finally(() => {
                              setPendingAction((current) =>
                                current?.key === slot.key && current.type === "book"
                                  ? null
                                  : current);
                            });
                        }}
                      >
                        {pendingAction?.key === slot.key && pendingAction.type === "book" ? "Booking..." : "Book"}
                      </button>
                    ) : slot.savedBooking ? (
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
                          disabled={pendingAction?.key === slot.key}
                          onClick={() => {
                            setPendingAction({ key: slot.key, type: "cancel" });
                            setActionMessage("");
                          void cancel.mutate(slot.savedBooking!)
                            .then(() => {
                              setActionMessage("Booking canceled.");
                            })
                              .catch((error) => {
                                logAppError("cancel booking failed", error, {
                                  scheduleId: props.schedule.id,
                                  savedBookingId: slot.savedBooking?.id ?? null,
                                });
                                setActionMessage(getErrorMessage(error, "Could not cancel booking."));
                              })
                              .finally(() => {
                                setPendingAction((current) =>
                                  current?.key === slot.key && current.type === "cancel"
                                    ? null
                                    : current);
                              });
                          }}
                        >
                          {pendingAction?.key === slot.key && pendingAction.type === "cancel" ? "Canceling..." : "Cancel"}
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
      {savedBookingsError ? <p className="error">{getErrorMessage(savedBookingsError, "Could not load your saved bookings.")}</p> : null}
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
