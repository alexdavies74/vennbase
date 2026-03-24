# @putbase/react

React hooks and provider for [PutBase](https://www.npmjs.com/package/@putbase/core) — a multi-user database for apps that have no backend. Users sign in with their [Puter](https://puter.com) accounts. Their data lives in their Puter storage.

See [`@putbase/core`](https://www.npmjs.com/package/@putbase/core) for the full API and schema documentation.

## Install

```bash
pnpm add @putbase/react @putbase/core
```

## Setup

Create one `PutBase` instance for your app.

```tsx
import { PutBase } from "@putbase/core";
import { schema } from "./schema";

const pb = new PutBase({ schema, appBaseUrl: window.location.origin });
```

If you want to read the PutBase instance from React context once, wrap your app in `<PutBaseProvider>` and call `usePutBase()` where needed:

```tsx
import { PutBaseProvider, usePutBase, useSession } from "@putbase/react";

export function App() {
  return (
    <PutBaseProvider pb={pb}>
      <AppShell />
    </PutBaseProvider>
  );
}

function AppShell() {
  const pb = usePutBase<Schema>();
  const session = useSession(pb);
  return <Main session={session} />;
}
```

## Auth

Use `useSession` to gate your UI on the auth state:

```tsx
import { useSession } from "@putbase/react";
import { pb } from "./pb";

function AppShell() {
  const session = useSession(pb);

  if (session.status === "loading") return <p>Checking session…</p>;

  if (!session.session?.signedIn) {
    return <button onClick={() => void session.signIn()}>Log in with Puter</button>;
  }

  return <Main />;
}
```

## Querying

`useQuery` polls for changes and re-renders automatically. `rows` is always a typed array — never `undefined`.

`useQuery(pb, "games", ...)` never means "all accessible games". If a collection is not declared as `in: ["user"]`, omitting `in` is an error.

```tsx
import { useQuery } from "@putbase/react";
import { pb } from "./pb";

function CardList({ board }: { board: BoardHandle }) {
  const { rows: cards } = useQuery<Schema, "cards">(pb, "cards", {
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

Collections declared as `in: ["user"]` keep the same ergonomics in React: if you omit `in`, PutBase queries inside the current signed-in user's built-in `user` row.

```tsx
function RecentBoards() {
  const { rows: recentBoards } = useQuery<Schema, "recentBoards">(pb, "recentBoards", {
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

If you need one row in React, prefer `useRow(pb, row)` over calling `pb.getRow(...)` in an effect and wiring your own polling loop. `row` can be either a `RowHandle` or a `RowRef`.

```tsx
import { useRow } from "@putbase/react";
import { pb } from "./pb";
import type { RowRef } from "@putbase/core";

function BoardTitle({ boardRef }: { boardRef: RowRef<"boards"> }) {
  const { data: board, status } = useRow<Schema, "boards">(pb, boardRef);

  if (status !== "success" || !board) return <p>Loading…</p>;
  return <h1>{board.fields.title}</h1>;
}
```

## Row Handle Identity

`useRow` and `useQuery` keep `RowHandle` identity stable for the life of a row within a `PutBase` instance. When the row fields change, the same handle object is reused and `row.fields` is replaced with a fresh snapshot object.

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

## CRDT bindings

Use row fields for queryable metadata and the CRDT document for collaborative value state.

`useCrdt` wires any `CrdtBinding` to a row. For Yjs, inject the app's own `Y` instance so `@putbase/yjs` never loads a second runtime:

```tsx
import * as Y from "yjs";
import { useRef } from "react";
import { useCrdt } from "@putbase/react";
import { createYjsBinding } from "@putbase/yjs";

function Room({ row }: { row: BoardHandle | null }) {
  const bindingRef = useRef(createYjsBinding(Y));
  const { value: doc, version } = useCrdt(row, bindingRef.current);

  const entries = doc.getArray<string>("messages").toArray();
  return <pre data-version={version}>{JSON.stringify(entries)}</pre>;
}
```

## Invite links

`useInviteLink` lazily generates (or reuses) an invite link for a row. `useInviteFromLocation` handles the recipient side: it detects PutBase invite URLs in the current location, waits for the session, calls `openInvite`, waits for `onOpen`, and then clears the invite params.

```tsx
import { useInviteLink, useInviteFromLocation } from "@putbase/react";
import { pb } from "./pb";

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { inviteLink } = useInviteLink(pb, board);
  return <button onClick={() => navigator.clipboard.writeText(inviteLink ?? "")}>Copy invite link</button>;
}

// Recipient side — call once near the app root
function InviteHandler() {
  useInviteFromLocation(pb, {
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
import { useMutation } from "@putbase/react";

function AddCard({ board }: { board: BoardHandle }) {
  const { mutate: addCard, status } = useMutation(async (text: string) => {
    const write = pb.put("cards", { text, done: false, createdAt: Date.now() }, { in: board });
    await write.settled;
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
| `useSession(pb)` | `PutBase` instance | `{ session, status, isRefreshing, error, refreshError, signIn, refresh }` |
| `useCurrentUser(pb)` | `PutBase` instance | `{ data: PutBaseUser, status, isRefreshing, error, refreshError, refresh }` |
| `usePutBase()` | — | `PutBase` instance from context |
| `usePutBaseReady(pb)` | `PutBase` instance | `{ status, isRefreshing, error, refreshError, refresh }` — resolves when auth + provisioning complete |
| `useQuery(pb, collection, options)` | pb, collection name, query options | `{ rows, data, status, isRefreshing, error, refreshError, refresh }` |
| `useRow(pb, row)` | pb, row handle or row ref | `{ data: RowHandle, status, isRefreshing, error, refreshError, refresh }` |
| `useParents(pb, row)` | pb, row handle or row ref | `{ data: RowRef[], status, isRefreshing, error, refreshError, refresh }` |
| `useMemberUsernames(pb, row)` | pb, row handle or row ref | `{ data: string[], status, isRefreshing, error, refreshError, refresh }` |
| `useDirectMembers(pb, row)` | pb, row handle or row ref | `{ data: { username, role }[], status, isRefreshing, error, refreshError, refresh }` |
| `useEffectiveMembers(pb, row)` | pb, row handle or row ref | `{ data: DbMemberInfo[], status, isRefreshing, error, refreshError, refresh }` |
| `useInviteLink(pb, row)` | pb, row handle or row ref | `{ inviteLink: string, status, isRefreshing, error, refreshError, refresh }` |
| `useInviteFromLocation(pb, options?)` | pb, `{ href?, clearLocation?, onOpen?, open? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh }` |
| `usePerUserRow(pb, options)` | pb, `{ key, href?, clearLocation?, loadRememberedRow?, openInvite?, getRow? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh, remember, clear }` |
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
  pb: PutBase<Schema>,
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseQueryResult<
  RowHandle<Schema, TCollection>
>
```

- `options: null | undefined` keeps the hook idle.
- `rows` is always an array and mirrors `data ?? []`.
- The row type matches `pb.query(...)`, including parent collection constraints.

### `useRow`

```ts
function useRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  pb: PutBase<Schema>,
  row: RowTarget<TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseResourceResult<
  RowHandle<Schema, TCollection>
>
```

- `row: null | undefined` keeps the hook idle.
- `row` can be either a `RowHandle` or `RowRef`.
- `useRow` polls for changes and re-renders automatically. In React, prefer it over manual polling around `pb.getRow(...)`.
- The returned handle matches `pb.getRow(...)`, including parent collection constraints.

### `useInviteLink`

```ts
function useInviteLink<Schema extends DbSchema>(
  pb: PutBase<Schema>,
  row: RowTarget | null | undefined,
  options?: UseHookOptions,
): {
  inviteLink: string | undefined;
  ...
}
```

- `row: null | undefined` keeps the hook idle.
- `row` can be either a `RowHandle` or `RowRef`.
- `inviteLink` is the generated or reused invite URL for the row.

### `useInviteFromLocation`

```ts
interface UseInviteFromLocationOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  href?: string | null;
  clearLocation?: boolean | ((url: URL) => string);
  onOpen?: (result: TResult) => void | Promise<void>;
  open?: (inviteInput: string, pb: PutBase<Schema>) => Promise<TResult>;
}

interface UseInviteFromLocationResult<TResult> extends UseResourceResult<TResult> {
  hasInvite: boolean;
  inviteInput: string | null;
}

function useInviteFromLocation<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
>(
  pb: PutBase<Schema>,
  options?: UseInviteFromLocationOptions<Schema, TResult>,
): UseInviteFromLocationResult<TResult>
```

- `href` defaults to `window.location.href`.
- `clearLocation` defaults to `true`.
- `onOpen` runs after invite acceptance succeeds and may be async.
- The hook stays in `loading` until `onOpen` finishes and the invite URL is cleared.
- Override `open` when invite acceptance should return something other than `pb.openInvite(...)`.

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
- Use it to wrap writes like `pb.put(...)`, `pb.update(...)`, or any other async workflow you want to expose as a React action state.
