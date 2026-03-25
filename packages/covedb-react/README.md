# @covedb/react

React hooks and provider for [CoveDB](https://www.npmjs.com/package/@covedb/core) — a multi-user database for apps that have no backend. Users sign in with their [Puter](https://puter.com) accounts. Their data lives in their Puter storage.

See [`@covedb/core`](https://www.npmjs.com/package/@covedb/core) for the full API and schema documentation.

## Install

```bash
pnpm add @covedb/react @covedb/core
```

## Setup

Create one `CoveDB` instance for your app.

```tsx
import { CoveDB } from "@covedb/core";
import { schema } from "./schema";

const db = new CoveDB({ schema, appBaseUrl: window.location.origin });
```

If you want to read the CoveDB instance from React context once, wrap your app in `<CoveDBProvider>` and call `useCoveDB()` where needed:

```tsx
import { CoveDBProvider, useCoveDB, useSession } from "@covedb/react";

export function App() {
  return (
    <CoveDBProvider db={db}>
      <AppShell />
    </CoveDBProvider>
  );
}

function AppShell() {
  const db = useCoveDB<Schema>();
  const session = useSession(db);
  return <Main session={session} />;
}
```

## Auth

Use `useSession` to gate your UI on the auth state:

```tsx
import { useSession } from "@covedb/react";
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

`useQuery` polls for changes and re-renders automatically. `rows` is always a typed array — never `undefined`.

`useQuery(db, "games", ...)` never means "all accessible games". If a collection is not declared as `in: ["user"]`, omitting `in` is an error.

```tsx
import { useQuery } from "@covedb/react";
import { db } from "./db";

function CardList({ board }: { board: BoardHandle }) {
  const { rows: cards } = useQuery<Schema, "cards">(db, "cards", {
    in: board,
    index: "byCreatedAt",
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

Collections declared as `in: ["user"]` keep the same ergonomics in React: if you omit `in`, CoveDB queries inside the current signed-in user's built-in `user` row.

```tsx
function RecentBoards() {
  const { rows: recentBoards } = useQuery<Schema, "recentBoards">(db, "recentBoards", {
    index: "byOpenedAt",
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
import { useRow } from "@covedb/react";
import { db } from "./db";
import type { RowRef } from "@covedb/core";

function BoardTitle({ boardRef }: { boardRef: RowRef<"boards"> }) {
  const { data: board, status } = useRow<Schema, "boards">(db, boardRef);

  if (status !== "success" || !board) return <p>Loading…</p>;
  return <h1>{board.fields.title}</h1>;
}
```

## Row Handle Identity

`useRow` and `useQuery` keep `RowHandle` identity stable for the life of a row within a `CoveDB` instance. When the row fields change, the same handle object is reused and `row.fields` is replaced with a fresh snapshot object.

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

`useCrdt` wires any `CrdtAdapter` to a row. For Yjs, inject the app's own `Y` instance so `@covedb/yjs` never loads a second runtime:

```tsx
import * as Y from "yjs";
import { useRef } from "react";
import { useCrdt } from "@covedb/react";
import { createYjsAdapter } from "@covedb/yjs";

function Room({ row }: { row: BoardHandle | null }) {
  const adapterRef = useRef(createYjsAdapter(Y));
  const { value: doc, version } = useCrdt(row, adapterRef.current);

  const entries = doc.getArray<string>("messages").toArray();
  return <pre data-version={version}>{JSON.stringify(entries)}</pre>;
}
```

## Invite links

`useShareLink` lazily generates (or reuses) a share link for a row. `useAcceptInviteFromUrl` handles the recipient side: it detects CoveDB invite URLs in the current URL, waits for the session, calls `acceptInvite`, waits for `onOpen`, and then clears the invite params.

```tsx
import { useShareLink, useAcceptInviteFromUrl } from "@covedb/react";
import { db } from "./db";

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { shareLink } = useShareLink(db, board);
  return <button onClick={() => navigator.clipboard.writeText(shareLink ?? "")}>Copy share link</button>;
}

// Recipient side — call once near the app root
function InviteHandler() {
  useAcceptInviteFromUrl(db, {
    onOpen: (board) => {
      // navigate to the shared board
    },
  });
  return null;
}
```

## Mutations

`useMutation` wraps any async call with `loading` / `success` / `error` state:

```tsx
import { useMutation } from "@covedb/react";

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
| `useSession(db)` | `CoveDB` instance | `{ session, status, isRefreshing, error, refreshError, signIn, refresh }` |
| `useCurrentUser(db)` | `CoveDB` instance | `{ data: CoveDBUser, status, isRefreshing, error, refreshError, refresh }` |
| `useCoveDB()` | — | `CoveDB` instance from context |
| `useCoveDBReady(db)` | `CoveDB` instance | `{ status, isRefreshing, error, refreshError, refresh }` — resolves when auth + provisioning complete |
| `useQuery(db, collection, options)` | db, collection name, query options | `{ rows, data, status, isRefreshing, error, refreshError, refresh }` |
| `useRow(db, row)` | db, row handle or row ref | `{ data: RowHandle, status, isRefreshing, error, refreshError, refresh }` |
| `useParents(db, row)` | db, row handle or row ref | `{ data: RowRef[], status, isRefreshing, error, refreshError, refresh }` |
| `useMemberUsernames(db, row)` | db, row handle or row ref | `{ data: string[], status, isRefreshing, error, refreshError, refresh }` |
| `useDirectMembers(db, row)` | db, row handle or row ref | `{ data: { username, role }[], status, isRefreshing, error, refreshError, refresh }` |
| `useEffectiveMembers(db, row)` | db, row handle or row ref | `{ data: DbMemberInfo[], status, isRefreshing, error, refreshError, refresh }` |
| `useShareLink(db, row)` | db, row handle or row ref | `{ shareLink: string, status, isRefreshing, error, refreshError, refresh }` |
| `useAcceptInviteFromUrl(db, options?)` | db, `{ url?, clearInviteParams?, onOpen?, accept? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh }` |
| `useSavedRow(db, options)` | db, `{ key, url?, clearInviteParams?, loadSavedRow?, acceptInvite?, getRow? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh, save, clear }` |
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
  rows: TRow[];
}
```

### `useQuery`

```ts
function useQuery<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  db: CoveDB<Schema>,
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseQueryResult<
  RowHandle<Schema, TCollection>
>
```

- `options: null | undefined` keeps the hook idle.
- `rows` is always an array and mirrors `data ?? []`.
- The row type matches `db.query(...)`, including parent collection constraints.

### `useRow`

```ts
function useRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  db: CoveDB<Schema>,
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
  db: CoveDB<Schema>,
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
interface UseAcceptInviteFromUrlOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  url?: string | null;
  clearInviteParams?: boolean | ((url: URL) => string);
  onOpen?: (result: TResult) => void | Promise<void>;
  accept?: (inviteInput: string, db: CoveDB<Schema>) => Promise<TResult>;
}

interface UseAcceptInviteFromUrlResult<TResult> extends UseResourceResult<TResult> {
  hasInvite: boolean;
  inviteInput: string | null;
}

function useAcceptInviteFromUrl<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
>(
  db: CoveDB<Schema>,
  options?: UseAcceptInviteFromUrlOptions<Schema, TResult>,
): UseAcceptInviteFromUrlResult<TResult>
```

- `url` defaults to `window.location.href`.
- `clearInviteParams` defaults to `true`.
- `onOpen` runs after invite acceptance succeeds and may be async.
- The hook stays in `loading` until `onOpen` finishes and the invite params are removed from the current URL.
- Override `accept` when invite acceptance should return something other than `db.acceptInvite(...)`.

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
