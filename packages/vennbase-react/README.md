# @vennbase/react

React hooks and provider for [Vennbase](https://vennbase.dev) — a multi-user database for apps that have no backend. Users sign in with their [Puter](https://puter.com) accounts. Their data lives in their Puter storage.

See [`@vennbase/core`](https://www.npmjs.com/package/@vennbase/core) for the full API and schema documentation.

## Install

```bash
pnpm add @vennbase/react @vennbase/core
```

## Setup

Create one `Vennbase` instance for your app.

```tsx
import { Vennbase } from "@vennbase/core";
import { schema } from "./schema";

const db = new Vennbase({ schema, appBaseUrl: window.location.origin });
```

If you want to read the Vennbase instance from React context once, wrap your app in `<VennbaseProvider>` and call `useVennbase()` where needed:

```tsx
import { VennbaseProvider, useVennbase, useSession } from "@vennbase/react";

export function App() {
  return (
    <VennbaseProvider db={db}>
      <AppShell />
    </VennbaseProvider>
  );
}

function AppShell() {
  const db = useVennbase<Schema>();
  const session = useSession(db);
  return <Main session={session} />;
}
```

## Auth

Use `useSession` to gate your UI on the auth state. It stays `loading` until a signed-in user is ready for synchronous Vennbase mutations:

```tsx
import { useSession } from "@vennbase/react";
import { db } from "./db";

function AppShell() {
  const session = useSession(db);

  if (session.status === "loading") return <p>Checking session…</p>;

  if (!session.session?.signedIn) {
    return <button onClick={() => void session.signIn()}>Log in with Puter</button>;
  }

  return <Main />;
}
```

## Querying

`useQuery` polls for changes and re-renders automatically.

`useQuery(db, "games", ...)` never means "all accessible games". `in` is always required. User-scoped collections use `in: CURRENT_USER`.

```tsx
import { CURRENT_USER } from "@vennbase/core";
import { useQuery } from "@vennbase/react";
import { db } from "./db";

function CardList({ board }: { board: BoardHandle }) {
  const { rows: cards = [], isLoading } = useQuery(db, "cards", {
    in: board,
    orderBy: "createdAt",
    order: "asc",
  });

  if (isLoading) return <p>Loading…</p>;

  return (
    <ul>
      {cards.map((card) => (
        <li key={card.id}>{card.fields.text}</li>
      ))}
    </ul>
  );
}
```

### Full rows vs index-key projections

By default, `useQuery` returns full `RowHandle` values. Those handles are locatable and can be passed to row-scoped hooks and helpers.
`where` and `orderBy` only work on fields declared with `.indexKey()`, and collections with no `.indexKey()` fields cannot use either option.

If you pass `select: "indexKeys"`, `useQuery` returns index-key projections shaped like `{ kind: "index-key-projection", id, collection, fields }`, where `fields` contains only values declared `.indexKey()`. They are for index-key visibility only and cannot be reopened or reused as row handles.

```tsx
function RecentBoards() {
  const { rows: recentBoards = [] } = useQuery(db, "recentBoards", {
    in: CURRENT_USER,
    orderBy: "openedAt",
    order: "desc",
    limit: 10,
  });

  return (
    <ul>
      {recentBoards.map((recentBoard) => (
        <li key={recentBoard.id}>{recentBoard.fields.boardRef.id}</li>
      ))}
    </ul>
  );
}
```

## Single-row reads

`useRow` is the single-row equivalent of `useQuery`: it polls for changes and re-renders automatically.

If you need one row in React, prefer `useRow(db, row)` over calling `db.getRow(...)` in an effect and wiring your own polling loop. `row` can be either a `RowHandle` or a `RowRef`.

```tsx
import { useRow } from "@vennbase/react";
import { db } from "./db";
import type { RowRef } from "@vennbase/core";

function BoardTitle({ boardRef }: { boardRef: RowRef<"boards"> }) {
  const { row: board, isLoading } = useRow(db, boardRef);

  if (isLoading || !board) return <p>Loading…</p>;
  return <h1>{board.fields.title}</h1>;
}
```

## Row Handle Identity

`useRow` and `useQuery` keep `RowHandle` identity stable for the life of a row within a `Vennbase` instance. When the row fields change, the same handle object is reused and `row.fields` is replaced with a fresh snapshot object.

That means using `[row]` as an effect dependency is safe for subscriptions keyed to the logical row. If your effect depends on row contents, depend on `row.fields` or specific field values instead.

```tsx
useEffect(() => {
  if (!row) return;
  const connection = row.connectCrdt(callbacks);
  return () => connection.disconnect();
}, [row]);
```

```tsx
useEffect(() => {
  if (!row) return;
  syncForm(row.fields);
}, [row?.fields]);
```

## CRDT adapters

Use row fields for queryable metadata and the CRDT document for collaborative value state.

`useCrdt` wires any `CrdtAdapter` to a row. For Yjs, inject the app's own `Y` instance so `@vennbase/yjs` never loads a second runtime:

```tsx
import * as Y from "yjs";
import { useRef } from "react";
import { useCrdt } from "@vennbase/react";
import { createYjsAdapter } from "@vennbase/yjs";

function Room({ row }: { row: BoardHandle | null }) {
  const adapterRef = useRef(createYjsAdapter(Y));
  const { value: doc, version } = useCrdt(row, adapterRef.current);

  const entries = doc.getArray<string>("messages").toArray();
  return <pre data-version={version}>{JSON.stringify(entries)}</pre>;
}
```

## Invite links

`useShareLink` lazily generates (or reuses) a share link for a row. Pass an explicit role such as `"all-editor"`, `"content-viewer"`, or `"index-submitter"` as the third argument. `useAcceptInviteFromUrl` handles the recipient side: it detects Vennbase invite URLs in the current URL, waits for the session, joins the invite, resolves either an opened row or a join-only membership result, runs `onOpen` for readable invites, runs `onResolve` for either branch, and then clears the invite params. It is a URL-consumption hook, not a router. If you also want to remember the opened row for restore-on-launch, persist it from those callbacks with `db.saveRow(...)`.

```tsx
import { useShareLink, useAcceptInviteFromUrl } from "@vennbase/react";
import { db } from "./db";

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { shareLink } = useShareLink(db, board, "all-editor");
  return <button onClick={() => navigator.clipboard.writeText(shareLink ?? "")}>Copy share link</button>;
}

// Recipient side — call once near the app root
function InviteHandler() {
  const invite = useAcceptInviteFromUrl(db, {
    onOpen: (board) => {
      // app-owned route state lives here
      console.log(board);
    },
  });

  if (invite.invitePhase === "waiting" || invite.invitePhase === "accepting") {
    return <p>Opening invite…</p>;
  }

  return null;
}
```

Readable invites resolve to `{ kind: "opened", row, ref, role }`. `index-*` links are join-only and resolve to `{ kind: "joined", ref, role }` without opening a row:

```tsx
function SubmissionHandler() {
  useAcceptInviteFromUrl(db, {
    onResolve: (result) => {
      if (result.kind !== "joined") return;
      console.log(result.ref, result.role);
    },
  });
  return null;
}
```

## Saved rows

`useSavedRow` is a narrow wrapper around `db.openSavedRow(...)`, `db.saveRow(...)`, and `db.clearSavedRow(...)`. It does not inspect the current URL or accept invites. Use it to restore one per-user row under an app-defined key, and compose it with `useAcceptInviteFromUrl` when invite acceptance should also update that saved slot.

When you compose them, give invite consumption precedence over restore:

1. Treat `invitePhase === "waiting" || invitePhase === "accepting"` as invite-in-progress.
2. In `onOpen` / `onResolve`, set your app-owned post-invite route state.
3. Only run saved-row restore once `invitePhase === "none"` and no invite-owned route state is active.
4. Treat signed-out UI separately from restore; `invitePhase !== "none"` only means there is an invite to consume or a recent invite delivery to finish.åååååå

```tsx
import { useAcceptInviteFromUrl, useSavedRow } from "@vennbase/react";
import { db } from "./db";

function AppRoot() {
  const invite = useAcceptInviteFromUrl(db, {
    onOpen: async (board) => {
      await db.saveRow("current-board", board.ref);
    },
  });
  const savedBoard = useSavedRow(db, {
    key: "current-board",
    collection: "boards",
    enabled: invite.invitePhase === "none",
  });

  const inviteLoading = invite.invitePhase === "waiting" || invite.invitePhase === "accepting";

  if (inviteLoading) {
    return <pre>Opening invite…</pre>;
  }

  return <pre>{savedBoard.row?.id ?? "No saved board yet."}</pre>;
}
```

If an `index-*` member needs sibling visibility, use `select: "indexKeys"` so the hook returns index-key projections containing only `kind`, `id`, `collection`, and index-key-only `fields`:

```tsx
function AvailabilityGrid({ availability }: { availability: RowRef<"availability"> }) {
  const { rows: bookings = [] } = useQuery(db, "bookings", {
    in: availability,
    select: "indexKeys",
    orderBy: "startTime",
    order: "asc",
  });

  return <pre>{JSON.stringify(bookings.map((row) => row.fields))}</pre>;
}
```

## Writes

Use the `Vennbase` instance directly for writes, no react-specific helper. `create` and `update` are synchronous optimistic writes, so most React code can call them inline and queries will re-render immediately:

```tsx
db.create("cards", { text: trimmed, done: false, createdAt: Date.now() }, { in: board });
```

```tsx
db.update("cards", card, { done: !card.fields.done });
```

## Hook reference

| Hook | Arguments | Returns |
|------|-----------|---------|
| `useSession(db)` | `Vennbase` instance | `{ session, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, signIn, refresh }` |
| `useCurrentUser(db)` | `Vennbase` instance | `{ user, data, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useVennbase()` | — | `Vennbase` instance from context |
| `useQuery(db, collection, options)` | db, collection name, query options with required `in` | `{ rows, data, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` where `rows` is `RowHandle[]` by default or index-key projections when `select: "indexKeys"` is used |
| `useRow(db, row)` | db, row handle or row ref | `{ row, data, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useParents(db, row)` | db, row handle or row ref | `{ data: RowRef[], status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useMemberUsernames(db, row)` | db, row handle or row ref | `{ data: string[], status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useDirectMembers(db, row)` | db, row handle or row ref | `{ data: { username, role }[], status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useEffectiveMembers(db, row)` | db, row handle or row ref | `{ data: DbMemberInfo[], status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useShareLink(db, row, role, options?)` | db, row handle or row ref, role `MemberRole`, optional `{ enabled }` | `{ shareLink: string, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useAcceptInviteFromUrl(db, options?)` | db, `{ enabled?, url?, clearInviteParams?, onOpen?, onResolve? }` | `{ invitePhase, blockingReason, inviteInput, data, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh }` |
| `useSavedRow(db, options)` | db, `{ key, collection, loadSavedRow?, getRow? }` | `{ row, data, status, isLoading, isIdle, isSuccess, isError, isRefreshing, error, refreshError, refresh, save, clear }` |
| `useMutation(fn)` | async function | `{ mutate, data, status, error, reset }` |

All data-fetching hooks return `status: "idle" | "loading" | "success" | "error"`. `loading` means there is no usable data yet. Once a hook has usable data, it stays `success` during background reloads and exposes that work through `isRefreshing` / `refreshError`.

## Commonly used types reference

```ts
interface UseHookOptions {
  enabled?: boolean;
}

interface UseResourceResult<TData> {
  data: TData | undefined;
  error: unknown;
  refreshError: unknown;
  isIdle: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isRefreshing: boolean;
  status: "idle" | "loading" | "success" | "error";
  refresh(): Promise<void>;
}

interface UseQueryResult<TRow> extends UseResourceResult<TRow[]> {
  rows: TRow[] | undefined;
}
```

The named payload field is the primary one when a hook has a natural domain object: `rows` for `useQuery`, `row` for `useRow` / `useSavedRow`, `user` for `useCurrentUser`, `session` for `useSession`, and `shareLink` for `useShareLink`. `data` and `status` are still available when you want generic plumbing.

### `useQuery`

```ts
function useQuery<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  db: Vennbase<Schema>,
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseQueryResult<
  RowHandle<Schema, TCollection>
>
```

- `options: null | undefined` keeps the hook idle.
- `rows` is `undefined` until the first usable result arrives.
- Once a query has succeeded, `rows` stays populated during background refreshes.
- `isLoading` is the ergonomic loading flag; `status` remains available when you need the full state machine.
- The row type matches `db.query(...)`, including parent collection constraints.

### `useRow`

```ts
function useRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  db: Vennbase<Schema>,
  row: RowInput<TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseResourceResult<RowHandle<Schema, TCollection>> & {
  row: RowHandle<Schema, TCollection> | undefined;
}
```

- `row: null | undefined` keeps the hook idle.
- `row` can be either a `RowHandle` or a `RowRef<"boards">`-style ref. `RowRef` only takes the collection name generic.
- `useRow` polls for changes and re-renders automatically. In React, prefer it over manual polling around `db.getRow(...)`.
- The returned handle matches `db.getRow(...)`, including parent collection constraints.
- Use `row` as the primary payload field and `isLoading` for the common loading check.

### `useShareLink`

```ts
function useShareLink<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
  role: MemberRole,
  options?: UseHookOptions,
): {
  shareLink: string | undefined;
  ...
}
```

- `row: null | undefined` keeps the hook idle.
- `row` can be either a `RowHandle` or `RowRef`.
- `shareLink` is the generated or reused invite URL for the row.

### `useAcceptInviteFromUrl`

```ts
interface OpenedInviteResult<Schema extends DbSchema> {
  kind: "opened";
  ref: RowRef;
  role: Exclude<MemberRole, `index-${string}`>;
  row: AnyRowHandle<Schema>;
}

interface JoinedInviteResult {
  kind: "joined";
  ref: RowRef;
  role: Extract<MemberRole, `index-${string}`>;
}

type AcceptedInviteResult<Schema extends DbSchema> =
  | OpenedInviteResult<Schema>
  | JoinedInviteResult;

interface UseAcceptInviteFromUrlOptions<Schema extends DbSchema> extends UseHookOptions {
  url?: string | null;
  clearInviteParams?: boolean | ((url: URL) => string);
  onOpen?: (row: AnyRowHandle<Schema>) => void | Promise<void>;
  onResolve?: (result: AcceptedInviteResult<Schema>) => void | Promise<void>;
}

interface UseAcceptInviteFromUrlResult<Schema extends DbSchema>
  extends UseResourceResult<AcceptedInviteResult<Schema>> {
  invitePhase: "none" | "waiting" | "accepting" | "resolved" | "error";
  blockingReason: "disabled" | "session-loading" | "signed-out" | "session-error" | null;
  inviteInput: string | null;
}

function useAcceptInviteFromUrl<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  options?: UseAcceptInviteFromUrlOptions<Schema>,
): UseAcceptInviteFromUrlResult<Schema>
```

- `url` defaults to `window.location.href`.
- `enabled` defaults to `true`
- `clearInviteParams` defaults to `true`.
- `invitePhase` describes the invite lifecycle. `"none"` means there is no current invite to consume. `"waiting"` means an invite is present but blocked on `enabled`, session initialization, or sign-in. `"accepting"` means join/open callbacks are in flight. `"resolved"` means the current render still exposes the accepted invite result before the cleared URL drops back to `"none"`. `"error"` means invite handling failed and the URL was not cleared.
- `blockingReason` explains why a `"waiting"` invite is blocked.
- `onOpen` runs only for readable invites and receives the opened row directly.
- `onResolve` runs after invite resolution succeeds and may be async.
- Readable invites resolve to `{ kind: "opened", row, ref, role }`.
- `index-*` invites resolve to `{ kind: "joined", ref, role }`.
- The hook consumes invite URLs and clears them after successful delivery. It does not preserve app-level route state for you.

### `useMutation`

```ts
function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): {
  mutate: (...args: TArgs) => Promise<TResult>;
  data: TResult | undefined;
  status: "idle" | "loading" | "success" | "error";
  error: unknown;
  reset(): void;
}
```
- Use it for async workflows where the UI needs action state, such as awaiting `.committed`, opening rows, or combining several async steps behind one button.
