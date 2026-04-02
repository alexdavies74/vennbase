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
  const { rows: cards = [], status } = useQuery(db, "cards", {
    in: board,
    orderBy: "createdAt",
    order: "asc",
  });

  return (
    <ul>
      {cards.map((card) => (
        <li key={card.id}>{card.fields.text}</li>
      ))}
    </ul>
  );
}
```

### Full rows vs anonymous projections

By default, `useQuery` returns full `RowHandle` values. Those handles are locatable and can be passed to row-scoped hooks and helpers.

If you pass `select: "anonymous"`, `useQuery` returns anonymous projections shaped like `{ kind: "anonymous-projection", id, collection, keyFields }`. They are for anonymous visibility only and cannot be reopened or reused as row handles.

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
  const { data: board, status } = useRow(db, boardRef);

  if (status !== "success" || !board) return <p>Loading…</p>;
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

`useShareLink` lazily generates (or reuses) a share link for a row. Always pass an explicit role such as `{ role: "editor" }`, `{ role: "contributor" }`, or `{ role: "submitter" }`. `useAcceptInviteFromUrl` handles the recipient side: it detects Vennbase invite URLs in the current URL, waits for the session, joins the invite, resolves either an opened row or a submitter-only membership result, runs `onOpen` for readable invites, runs `onResolve` for either branch, and then clears the invite params. If you also want to remember the opened row for restore-on-launch, persist it from those callbacks with `db.saveRow(...)`.

```tsx
import { useShareLink, useAcceptInviteFromUrl } from "@vennbase/react";
import { db } from "./db";

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { shareLink } = useShareLink(db, board, { role: "editor" });
  return <button onClick={() => navigator.clipboard.writeText(shareLink ?? "")}>Copy share link</button>;
}

// Recipient side — call once near the app root
function InviteHandler() {
  useAcceptInviteFromUrl(db, {
    onOpen: (board) => {
      // navigate to the shared board
      console.log(board);
    },
  });
  return null;
}
```

Submitter links now resolve directly without a workaround:

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

```tsx
import { useAcceptInviteFromUrl, useSavedRow } from "@vennbase/react";
import { db } from "./db";

function AppRoot() {
  const savedBoard = useSavedRow(db, { key: "current-board" });

  useAcceptInviteFromUrl(db, {
    onOpen: async (board) => {
      await db.saveRow("current-board", board.ref);
    },
  });

  return <pre>{savedBoard.data?.id ?? "No saved board yet."}</pre>;
}
```

If a submitter needs anonymized sibling visibility, use `select: "anonymous"` so the hook returns anonymous projections containing only `kind`, `id`, `collection`, and `keyFields`:

```tsx
function AvailabilityGrid({ availability }: { availability: RowRef<"availability"> }) {
  const { rows: bookings = [] } = useQuery(db, "bookings", {
    in: availability,
    select: "anonymous",
    orderBy: "startTime",
    order: "asc",
  });

  return <pre>{JSON.stringify(bookings.map((row) => row.keyFields))}</pre>;
}
```

## Mutations

`useMutation` wraps any async call with `loading` / `success` / `error` state:

```tsx
import { useMutation } from "@vennbase/react";

function AddCard({ board }: { board: BoardHandle }) {
  const { mutate: addCard, status } = useMutation(async (text: string) => {
    const write = db.create("cards", { text, done: false, createdAt: Date.now() }, { in: board });
    await write.committed;
    return write.value;
  });

  return (
    <button disabled={status === "loading"} onClick={() => addCard("New card")}>
      Add card
    </button>
  );
}
```

## Hook reference

| Hook | Arguments | Returns |
|------|-----------|---------|
| `useSession(db)` | `Vennbase` instance | `{ session, status, isRefreshing, error, refreshError, signIn, refresh }` |
| `useCurrentUser(db)` | `Vennbase` instance | `{ data: VennbaseUser, status, isRefreshing, error, refreshError, refresh }` |
| `useVennbase()` | — | `Vennbase` instance from context |
| `useQuery(db, collection, options)` | db, collection name, query options with required `in` | `{ rows, data, status, isRefreshing, error, refreshError, refresh }` where `rows` is `RowHandle[]` by default or anonymous projections when `select: "anonymous"` is used |
| `useRow(db, row)` | db, row handle or row ref | `{ data: RowHandle, status, isRefreshing, error, refreshError, refresh }` |
| `useParents(db, row)` | db, row handle or row ref | `{ data: RowRef[], status, isRefreshing, error, refreshError, refresh }` |
| `useMemberUsernames(db, row)` | db, row handle or row ref | `{ data: string[], status, isRefreshing, error, refreshError, refresh }` |
| `useDirectMembers(db, row)` | db, row handle or row ref | `{ data: { username, role }[], status, isRefreshing, error, refreshError, refresh }` |
| `useEffectiveMembers(db, row)` | db, row handle or row ref | `{ data: DbMemberInfo[], status, isRefreshing, error, refreshError, refresh }` |
| `useShareLink(db, row, options)` | db, row handle or row ref, `{ role: "editor" \| "contributor" \| "viewer" \| "submitter" }` | `{ shareLink: string, status, isRefreshing, error, refreshError, refresh }` |
| `useAcceptInviteFromUrl(db, options?)` | db, `{ url?, clearInviteParams?, onOpen?, onResolve? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh }` |
| `useSavedRow(db, options)` | db, `{ key, loadSavedRow?, getRow? }` | `{ data, status, isRefreshing, error, refreshError, refresh, save, clear }` |
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
  isRefreshing: boolean;
  status: "idle" | "loading" | "success" | "error";
  refresh(): Promise<void>;
}

interface UseQueryResult<TRow> extends UseResourceResult<TRow[]> {
  rows: TRow[] | undefined;
}
```

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
): UseResourceResult<
  RowHandle<Schema, TCollection>
>
```

- `row: null | undefined` keeps the hook idle.
- `row` can be either a `RowHandle` or `RowRef`.
- `useRow` polls for changes and re-renders automatically. In React, prefer it over manual polling around `db.getRow(...)`.
- The returned handle matches `db.getRow(...)`, including parent collection constraints.

### `useShareLink`

```ts
function useShareLink<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
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
  role: "editor" | "contributor" | "viewer";
  row: AnyRowHandle<Schema>;
}

interface JoinedInviteResult {
  kind: "joined";
  ref: RowRef;
  role: "submitter";
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
  hasInvite: boolean;
  inviteInput: string | null;
}

function useAcceptInviteFromUrl<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  options?: UseAcceptInviteFromUrlOptions<Schema>,
): UseAcceptInviteFromUrlResult<Schema>
```

- `url` defaults to `window.location.href`.
- `clearInviteParams` defaults to `true`.
- `onOpen` runs only for readable invites and receives the opened row directly.
- `onResolve` runs after invite resolution succeeds and may be async.
- Readable invites resolve to `{ kind: "opened", row, ref, role }`.
- Submitter invites resolve to `{ kind: "joined", ref, role: "submitter" }`.
- The hook stays in `loading` until `onOpen` and `onResolve` finish and the invite params are removed from the current URL.

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
- Use it to wrap writes like `db.create(...)`, `db.update(...)`, or any other async workflow you want to expose as a React action state.
