# @putbase/react

React hooks and provider for [PutBase](https://www.npmjs.com/package/@putbase/core) — a multi-user database for apps that have no backend. Users sign in with their [Puter](https://puter.com) accounts. Their data lives in their Puter storage.

See [`@putbase/core`](https://www.npmjs.com/package/@putbase/core) for the full API and schema documentation.

## Install

```bash
pnpm add @putbase/react @putbase/core
```

## Setup

Create one `PutBase` instance and wrap your app in `<PutBaseProvider>`:

```tsx
import { PutBase } from "@putbase/core";
import { PutBaseProvider } from "@putbase/react";
import { schema } from "./schema";

const db = new PutBase({ schema, appBaseUrl: window.location.origin });

export function App() {
  return (
    <PutBaseProvider client={db}>
      <AppShell />
    </PutBaseProvider>
  );
}
```

## Auth

Use `useSession` to gate your UI on the auth state:

```tsx
import { useSession } from "@putbase/react";

function AppShell() {
  const session = useSession();

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

function CardList({ board }: { board: BoardHandle }) {
  const { rows: cards } = useQuery<Schema, "cards">("cards", {
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

// Sharer side
function ShareButton({ board }: { board: BoardHandle }) {
  const { data: link } = useInviteLink(board);
  return <button onClick={() => navigator.clipboard.writeText(link ?? "")}>Copy invite link</button>;
}

// Recipient side — call once near the app root
function InviteHandler() {
  useInviteFromLocation({
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

All hooks accept an optional final `{ client?, enabled? }` argument to override the context client or conditionally disable the hook.

| Hook | Arguments | Returns |
|------|-----------|---------|
| `useSession()` | — | `{ session, signIn, status, refresh }` |
| `useCurrentUser()` | — | `{ data: PutBaseUser, status, refresh }` |
| `usePutBase()` | — | `PutBase` client from context |
| `usePutBaseReady()` | — | `{ status, refresh }` — resolves when auth + provisioning complete |
| `useQuery(collection, options)` | collection name, query options | `{ rows, data, status, error, refresh }` |
| `useRow(collection, row)` | collection name, row ref | `{ data: RowHandle, status, error, refresh }` |
| `useRowTarget(target)` | target URL string | `{ data: RowHandle, status, error, refresh }` |
| `useParents(row)` | row ref | `{ data: DbRowRef[], status, error, refresh }` |
| `useMemberUsernames(row)` | row ref | `{ data: string[], status, error, refresh }` |
| `useDirectMembers(row)` | row ref | `{ data: { username, role }[], status, error, refresh }` |
| `useEffectiveMembers(row)` | row ref | `{ data: DbMemberInfo[], status, error, refresh }` |
| `useInviteLink(row)` | row ref | `{ data: string, status, error, refresh }` |
| `useInviteFromLocation(options?)` | `{ href?, clearLocation?, onOpen?, open? }` | `{ hasInvite, inviteInput, data, status, error, refresh }` |
| `useMutation(fn)` | async function | `{ mutate, data, status, error, reset }` |

All data-fetching hooks return `status: "idle" | "loading" | "success" | "error"`.
