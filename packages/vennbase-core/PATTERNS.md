# Advanced patterns — appointment-app

The `packages/appointment-app` example demonstrates three access-control patterns for booking and claiming shared resources. This is a recipe-style walkthrough of each.

Run the app with:

```bash
pnpm --filter appointment-app dev
```

The schema lives in `packages/appointment-app/src/schema.ts`. The service layer lives in `packages/appointment-app/src/service.ts`.

---

## Pattern 1: Blind booking inbox

**Problem.** Customers need to create bookings under a parent row that only the owner can read. The owner doesn't want to send each customer a separate invite.

**Trick.** Store the submitter link for the hidden `bookingRoots` row as a plain string field on the *readable* `schedules` row. Any viewer of the schedule calls `joinInvite(...)` on that embedded link to gain submitter access to the inbox — without ever getting readable access to it.

**Owner side — create the inbox and embed its link in the schedule:**

```ts
const bookingRootWrite = this.db.create("bookingRoots", { createdAt: Date.now() });
const bookingRoot = bookingRootWrite.value;
await bookingRootWrite.committed;

const bookingSubmitterLink = await this.db.createShareLink(bookingRoot.ref, "submitter").committed;
this.db.create("schedules", {
  ...draftToScheduleFields(draft),
  bookingSubmitterLink,  // stored as a plain string field on the readable row
});
```

**Customer side — claim submitter access from the embedded link:**

```ts
async ensureBookingRootAccess(schedule: ScheduleHandle): Promise<BookingRootRef> {
  const joined = await this.db.joinInvite(schedule.fields.bookingSubmitterLink);
  return joined.ref as BookingRootRef;
}
```

`joinInvite` is idempotent — calling it again on a link the user already joined is a no-op. Call it every time a customer opens a schedule; no local state needed.

The customer never holds a viewer link to `bookingRoots` itself, so they cannot read the parent row, inspect its members, or see other customers' full booking records.

---

## Pattern 2: Anonymized sibling visibility with `select: "keys"`

**Problem.** Customers need to see which slots are already taken so they can pick an open one — but they shouldn't see other customers' private booking details.

**Trick.** Query with `select: "keys"`. Submitters can run this query against the inbox without needing read access to the parent. The response is an anonymous projection: it includes only `id`, `collection`, and fields declared `.key()` in the schema.

**In the UI** — reactive:

```ts
const { rows: sharedBookings = [] } = useQuery(db, "bookings", {
  in: props.bookingRootRef,
  select: "keys",
  limit: 500,
});
```

For capacity-limited booking, the recommended pattern is **write first, then arbitrate on the read path**:

```ts
await this.db.create("bookings", {
  slotStartMs: args.slotStartMs,
  slotEndMs: args.slotEndMs,
  claimedAtMs: Date.now(),
}, {
  in: args.bookingRootRef,
}).committed;
```

Then derive the active booking from the visible rows:

1. group claims by `{ slotStartMs, slotEndMs }`
2. sort each group by `(claimedAtMs, id)`
3. use a fixed app-level cooloff window such as 5 seconds
4. before `firstClaim.claimedAtMs + cooloffMs`, treat the slot as `pending`
5. after cooloff, treat only the first claim as active
6. if that claim disappears later, recompute from the remaining rows and the next claim becomes active

`select: "keys"` works in both `useQuery` and the imperative `db.query`. No additional permissions are required — submitter access already allows key-only sibling queries. These projected rows are not locatable row refs; use a full query if you need to reopen a row later.

This gives **honest convergence**, not fairness against malicious writers. All well-behaved clients will compute the same winner from the same visible rows, but a malicious writer can still bias the outcome by choosing favorable visible tiebreak values.

---

## Pattern 3: Minimal key fields

`select: "keys"` only exposes fields declared `.key()`. The `bookings` schema is designed so key-only results contain just enough to render an occupied-slots calendar — nothing more:

```ts
bookings: collection({
  in: ["bookingRoots"],
  fields: {
    slotStartMs: field.number().key(),  // exposed by select: "keys"
    slotEndMs:   field.number().key(),  // exposed by select: "keys"
    claimedAtMs: field.number().key(),  // visible tiebreak for read-side arbitration
  },
}),
```

**Design rule:** before marking a field `.key()`, ask whether it is safe for submitters to read. If not, leave `.key()` off and it will never appear in key-only queries, regardless of what is added to the schema later. For this pattern, `claimedAtMs` is intentionally visible so all clients can run the same deterministic tiebreak.

---

## How the three patterns compose

The app wires all three together into a single access-control surface the owner never has to touch again:

1. **Owner creates a schedule.** During creation, a hidden `bookingRoots` row is created and its submitter link is stored in `schedule.fields.bookingSubmitterLink`.
2. **Owner shares the schedule** using a viewer share link. Customers open it.
3. **Customer joins the inbox** — Pattern 1. `ensureBookingRootAccess` calls `joinInvite` on the embedded link, returning a `BookingRootRef` with submitter access.
4. **Customer creates a claim** under the `BookingRootRef`. No preflight race check is needed.
5. **Customer queries visible claims** — Patterns 2 and 3. `select: "keys"` returns `{ slotStartMs, slotEndMs, claimedAtMs }` from sibling bookings. Clients apply a fixed cooloff window and the `(claimedAtMs, id)` tiebreak to decide which claim is active.
6. **Owner and customers converge** on the same active booking from the same visible rows. Only the owner (with full access) can read the complete booking records.

The owner never manually grants or revokes customer access. The submitter link embedded in the schedule is the entire access-control surface.
