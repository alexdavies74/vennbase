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

  if (session.session.state === "signed-out") {
    return <button onClick={() => void session.signIn()}>Log in with Puter</button>;
  }

  return <Main />;
}
```

## Querying

`useQuery` polls for changes and re-renders automatically. `rows` is always a typed array — never `undefined`.

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

## Invite links

`useInviteLink` lazily generates (or reuses) an invite link for a row. `useInviteFromLocation` handles the recipient side: it detects an invite in the current URL, waits for the session, calls `openInvite`, and clears the URL params.

```tsx
import { useInviteLink, useInviteFromLocation } from "@putbase/react";
import { db } from "./db";

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { data: link } = useInviteLink(db, board);
  return <button onClick={() => navigator.clipboard.writeText(link ?? "")}>Copy invite link</button>;
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

For a single "current row" per signed-in user, `usePerUserRow` combines invite precedence, remembered target restore, and explicit `remember()` / `clear()` helpers:

```tsx
import { usePerUserRow } from "@putbase/react";

function AppShell() {
  const currentBoard = usePerUserRow(db, {
    key: "current-board",
  });

  if (currentBoard.status === "loading") return <p>Opening board…</p>;
  if (currentBoard.data == null) return <button onClick={async () => {
    const board = await db.put("boards", { title: "Launch checklist" });
    await currentBoard.remember(board);
  }}>Create board</button>;

  return <BoardScreen board={currentBoard.data} />;
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

All PutBase-backed hooks are client-first and accept an optional final `{ enabled? }` argument.

| Hook | Arguments | Returns |
|------|-----------|---------|
| `useSession(client)` | `PutBase` client | `{ session, signIn, status, refresh }` |
| `useCurrentUser(client)` | `PutBase` client | `{ data: PutBaseUser, status, refresh }` |
| `usePutBase()` | — | `PutBase` client from context |
| `usePutBaseReady(client)` | `PutBase` client | `{ status, refresh }` — resolves when auth + provisioning complete |
| `useQuery(client, collection, options)` | client, collection name, query options | `{ rows, data, status, error, refresh }` |
| `useRow(client, row)` | client, row ref | `{ data: RowHandle, status, error, refresh }` |
| `useRowTarget(client, target)` | client, target URL string | `{ data: RowHandle, status, error, refresh }` |
| `useParents(client, row)` | client, row ref | `{ data: DbRowRef[], status, error, refresh }` |
| `useMemberUsernames(client, row)` | client, row ref | `{ data: string[], status, error, refresh }` |
| `useDirectMembers(client, row)` | client, row ref | `{ data: { username, role }[], status, error, refresh }` |
| `useEffectiveMembers(client, row)` | client, row ref | `{ data: DbMemberInfo[], status, error, refresh }` |
| `useInviteLink(client, row)` | client, row ref | `{ data: string, status, error, refresh }` |
| `useInviteFromLocation(client, options?)` | client, `{ href?, clearLocation?, onOpen?, open? }` | `{ hasInvite, inviteInput, data, status, error, refresh }` |
| `usePerUserRow(client, options)` | client, `{ key, href?, clearLocation?, loadRememberedRow?, openInvite?, getRow? }` | `{ hasInvite, inviteInput, data, status, error, refresh, remember, clear }` |
| `useMutation(fn)` | async function | `{ mutate, data, status, error, reset }` |

All data-fetching hooks return `status: "idle" | "loading" | "success" | "error"`.
