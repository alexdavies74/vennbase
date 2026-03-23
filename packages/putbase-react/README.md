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

const db = new PutBase({ schema, appBaseUrl: window.location.origin });
```

If you want to read the client from React context once, wrap your app in `<PutBaseProvider>` and call `usePutBase()` where needed:

```tsx
import { PutBaseProvider, usePutBase, useSession } from "@putbase/react";

export function App() {
  return (
    <PutBaseProvider client={db}>
      <AppShell />
    </PutBaseProvider>
  );
}

function AppShell() {
  const db = usePutBase<Schema>();
  const session = useSession(db);
  return <Main session={session} />;
}
```

## Auth

Use `useSession` to gate your UI on the auth state:

```tsx
import { useSession } from "@putbase/react";
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
import { useQuery } from "@putbase/react";
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

Collections declared as `in: ["user"]` keep the same ergonomics in React: if you omit `in`, PutBase queries inside the current signed-in user's built-in `user` row.

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
        <li key={recentBoard.id}>{recentBoard.fields.boardTarget}</li>
      ))}
    </ul>
  );
}
```

## Row Handle Identity

`useRow`, `useRowTarget`, and `useQuery` keep `RowHandle` identity stable for the life of a row within a `PutBase` client. When the row fields change, the same handle object is reused and `row.fields` is replaced with a fresh snapshot object.

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

`useInviteLink` lazily generates (or reuses) an invite link for a row. `useInviteFromLocation` handles the recipient side: it detects PutBase invite URLs in the current location, waits for the session, calls `openInvite`, and clears the invite params.

```tsx
import { useInviteLink, useInviteFromLocation } from "@putbase/react";
import { db } from "./db";

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { inviteLink } = useInviteLink(db, board);
  return <button onClick={() => navigator.clipboard.writeText(inviteLink ?? "")}>Copy invite link</button>;
}

// Recipient side — call once near the app root
function InviteHandler() {
  useInviteFromLocation(db, {
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
  const { mutate: addCard, status } = useMutation((text: string) =>
    db.put("cards", { text, done: false, createdAt: Date.now() }, { in: board }),
  );

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
| `useSession(client)` | `PutBase` client | `{ session, status, isRefreshing, error, refreshError, signIn, refresh }` |
| `useCurrentUser(client)` | `PutBase` client | `{ data: PutBaseUser, status, isRefreshing, error, refreshError, refresh }` |
| `usePutBase()` | — | `PutBase` client from context |
| `usePutBaseReady(client)` | `PutBase` client | `{ status, isRefreshing, error, refreshError, refresh }` — resolves when auth + provisioning complete |
| `useQuery(client, collection, options)` | client, collection name, query options | `{ rows, data, status, isRefreshing, error, refreshError, refresh }` |
| `useRow(client, row)` | client, row ref | `{ data: RowHandle, status, isRefreshing, error, refreshError, refresh }` |
| `useRowTarget(client, target)` | client, target URL string | `{ data: RowHandle, status, isRefreshing, error, refreshError, refresh }` |
| `useParents(client, row)` | client, row ref | `{ data: DbRowRef[], status, isRefreshing, error, refreshError, refresh }` |
| `useMemberUsernames(client, row)` | client, row ref | `{ data: string[], status, isRefreshing, error, refreshError, refresh }` |
| `useDirectMembers(client, row)` | client, row ref | `{ data: { username, role }[], status, isRefreshing, error, refreshError, refresh }` |
| `useEffectiveMembers(client, row)` | client, row ref | `{ data: DbMemberInfo[], status, isRefreshing, error, refreshError, refresh }` |
| `useInviteLink(client, row)` | client, row ref | `{ inviteLink: string, status, isRefreshing, error, refreshError, refresh }` |
| `useInviteFromLocation(client, options?)` | client, `{ href?, clearLocation?, onOpen?, open? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh }` |
| `usePerUserRow(client, options)` | client, `{ key, href?, clearLocation?, loadRememberedRow?, openInvite?, getRow? }` | `{ hasInvite, inviteInput, data, status, isRefreshing, error, refreshError, refresh, remember, clear }` |
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
  client: PutBase<Schema>,
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseQueryResult<
  RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>
>
```

- `options: null | undefined` keeps the hook idle.
- `rows` is always an array and mirrors `data ?? []`.
- The row type matches `client.query(...)`, including parent collection constraints.

### `useRow`

```ts
function useRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  client: PutBase<Schema>,
  row: DbRowRef<TCollection> | null | undefined,
  hookOptions?: UseHookOptions,
): UseResourceResult<
  RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>
>
```

- `row: null | undefined` keeps the hook idle.
- The returned handle matches `client.getRow(...)`, including parent collection constraints.

### `useRowTarget`

```ts
function useRowTarget<Schema extends DbSchema>(
  client: PutBase<Schema>,
  target: string | null | undefined,
  options?: UseHookOptions,
): UseResourceResult<AnyRowHandle<Schema>>
```

- `target: null | undefined` keeps the hook idle.
- The return type is `AnyRowHandle<Schema>` because the target string does not carry a collection literal.

### `useInviteLink`

```ts
function useInviteLink<Schema extends DbSchema>(
  client: PutBase<Schema>,
  row: DbRowRef | null | undefined,
  options?: UseHookOptions,
): {
  inviteLink: string | undefined;
  ...
}
```

- `row: null | undefined` keeps the hook idle.
- `inviteLink` is the generated or reused invite URL for the row.

### `useInviteFromLocation`

```ts
interface UseInviteFromLocationOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  href?: string | null;
  clearLocation?: boolean | ((url: URL) => string);
  onOpen?: (result: TResult) => void;
  open?: (inviteInput: string, client: PutBase<Schema>) => Promise<TResult>;
}

interface UseInviteFromLocationResult<TResult> extends UseResourceResult<TResult> {
  hasInvite: boolean;
  inviteInput: string | null;
}

function useInviteFromLocation<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
>(
  client: PutBase<Schema>,
  options?: UseInviteFromLocationOptions<Schema, TResult>,
): UseInviteFromLocationResult<TResult>
```

- `href` defaults to `window.location.href`.
- `clearLocation` defaults to `true`.
- `onOpen` runs after invite acceptance succeeds.
- Override `open` when invite acceptance should return something other than `db.openInvite(...)`.

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
=
- Use it to wrap writes like `db.put(...)`, `row.update(...)`, or any other async workflow you want to expose as a React action state.
