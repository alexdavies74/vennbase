# PutBase

**A multi-user database for apps that have no backend.**

PutBase is a TypeScript SDK that gives your web app collaborative, multi-user data storage — without you ever running a server. Users sign in with their [Puter](https://puter.com) accounts. Their data lives in their Puter storage. You write a schema, call `put` and `query`, share invite links, and you're done.

This makes PutBase particularly well-suited for:

- **Hobbyists and open-source projects** — no infrastructure to run or pay for
- **Apps built by AI coding agents** — the explicit-grant access model is simple enough that even a small-context agent can reason about it correctly
- **Apps with user-pays AI** — Puter provides AI APIs billed to the user's own account, so you can build AI-powered features with zero hosting cost and a single login flow

```ts
// Write
const board = db.put("boards", { title: "Launch checklist" }).value;
db.put("cards", { text: "Ship it", done: false, createdAt: Date.now() }, { in: board });

// Read (React)
const { rows: cards } = useQuery<Schema, "cards">(db, "cards", {
  in: board,
  index: "byCreatedAt",
  order: "asc",
});

// Share
const { inviteLink } = useInviteLink(db, board);
```

---

## How it works

Every piece of data in PutBase is a **row**. A row belongs to a **collection** defined in your schema, holds typed fields, and has its own identity and access control. You get a `RowHandle` when you create or fetch a row — that handle is your entry point for reading fields, sharing the row, and subscribing to real-time updates.

Rows can be nested. A collection can declare that its rows live **inside** a parent collection: a `card` lives inside a `board`, and a `recentBoard` row lives inside the built-in `user` collection. The parent relationship constrains who can see child rows — gaining access to a parent automatically makes the children visible too.

Access control is **explicit-grant only**. There are no complex rule expressions to misconfigure. To let another user into a row, you generate an invite link and send it to them. They accept it, they're in. That's the whole model.

---

## Install

```bash
pnpm add @putbase/core
```

Using React? Start with `@putbase/react`.

---

## Schema

Define your collections once. TypeScript infers field types throughout the SDK automatically.

```ts
import { collection, defineSchema, field, index } from "@putbase/core";

export const schema = defineSchema({
  boards: collection({
    fields: {
      title: field.string(),
    },
  }),
  recentBoards: collection({
    in: ["user"],
    fields: {
      boardRef: field.ref("boards"),
      openedAt: field.number(),
    },
    indexes: {
      byBoardRef: index("boardRef"),
      byOpenedAt: index("openedAt"),
    },
  }),
  cards: collection({
    in: ["boards"],
    fields: {
      text: field.string(),
      done: field.boolean(),
      createdAt: field.number(),
    },
    indexes: {
      byCreatedAt: index("createdAt"),
    },
  }),
});

export type Schema = typeof schema;
```

- `collection({ in: [...] })` — `in` lists the allowed parent collections.
- `field.string()` / `.number()` / `.boolean()` / `.date()` / `.ref(collection)` — typed fields; chain `.optional()` or `.default(value)` as needed
- `index(fieldName)` — makes a field queryable with ordering and range filters

Fields are for metadata that you want to query or index. The canonical CRDT pattern is: row fields hold metadata and row refs, while the CRDT document holds the collaborative value state for that row.

---

## Setup

Create one `PutBase` instance for your app and pass it an `appBaseUrl` so that invite links point back to your app:

```ts
import { PutBase } from "@putbase/core";
import { schema } from "./schema";

export const db = new PutBase({ schema, appBaseUrl: window.location.origin });
```

## Auth and startup

Use `getSession()` to detect whether the current browser already has a Puter session, and call `signIn()` from a user gesture when it does not:

```ts
const session = await db.getSession();

if (!session.signedIn) {
  await db.signIn();        // call this from a button click
}

await db.ensureReady();
```


---

## Creating rows

```ts
// Create a top-level row
const board = db.put("boards", { title: "Launch checklist" }).value;

// Create a child row — pass the parent row or row ref
db.put("cards", { text: "Write README", done: false, createdAt: Date.now() }, { in: board });
db.put("cards", { text: "Publish to npm", done: false, createdAt: Date.now() }, { in: board });
```

`put` and `update` are synchronous optimistic writes. Use `.value` on the returned receipt when you want the row handle immediately.

To update fields on an existing row:

```ts
db.update("cards", card, { done: true });
```

---

## Querying

PutBase queries always run within a known scope. For `cards`, that scope is a `board`, so you pass `in: board`. For collections declared as `in: ["user"]`, omitting `in` means "use the current signed-in user's built-in `user` row."

Queries never mean "all accessible rows". If a collection is not declared as `in: ["user"]`, omitting `in` is an error.

### Imperative

```ts
// `recentBoards` is declared as `in: ["user"]`, so the current user scope is implicit.
const recentBoards = await db.query("recentBoards", {
  index: "byOpenedAt",
  order: "desc",
  limit: 10,
});
```

```ts
// Multi-parent queries run in parallel, then merge and sort their results
const shelf = await db.query("recentBoards", {
  in: [personalHome, sharedHome],
  index: "byOpenedAt",
  order: "desc",
  limit: 20,
});
```

### With React

`@putbase/react` ships a `useQuery` hook that polls for changes and re-renders automatically:

```tsx
import { useQuery } from "@putbase/react";

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

`rows` is always a typed array — never `undefined`. Other hooks in `@putbase/react`: `useRow`, `useCurrentUser`, `useInviteLink`, `useInviteFromLocation`, `useMemberUsernames`, `useDirectMembers`, and `useMutation`.


For app boot, prefer `useSession(db)`:

```tsx
import { useSession } from "@putbase/react";

function AppShell() {
  const session = useSession(db);

  if (session.status === "loading") {
    return <p>Checking session…</p>;
  }

  if (!session.session?.signedIn) {
    return <button onClick={() => void session.signIn()}>Log in with Puter</button>;
  }

  return <App />;
}
```

---

## Sharing rows with invite links

Access to a row is always explicit. There is no rule system to misconfigure — no typo in a policy expression that accidentally exposes everything. A user either holds a valid invite token or they don't.

Sharing is a three-step flow:

```ts
// 1. Generate a token for the row you want to share
const token = db.createInviteToken(board).value;

// 2. Build a link the recipient can open in their browser
const link = db.createInviteLink(board, token.token);
// → "https://yourapp.com/?pb=..."

// 3. Recipient opens the link; your app calls openInvite
const board = await db.openInvite(link);
```

`openInvite` accepts either a full invite URL (including the one in `window.location.href` when the user lands on your page) or a pre-parsed `{ ref, inviteToken? }` object from `db.parseInvite(input)`.

In React apps, `useInviteFromLocation(db, ...)` wraps the common invite-landing flow: detect the current invite URL, wait for session resolution, call `openInvite`, optionally await `onOpen`, and optionally remove the invite params from the address bar after success with `clearInviteParams`.

Users who join through an invite token are added as direct `"writer"` members by default. `"reader"` members can view rows but cannot call `update()` or send CRDT messages.

---

## Membership

Once users have joined a row you can inspect and manage the member list:

```ts
// Flat list of usernames
const members = await db.listMembers(board);

// With roles
const detailed = await db.listDirectMembers(board);
// → [{ username: "alice", role: "writer" }, ...]

// Add or remove manually
await db.addMember(board, "bob", "writer").settled;
await db.removeMember(board, "eve").settled;
```

Membership inherited through a parent row is visible via `listEffectiveMembers`.

---

## Real-time sync (CRDT)

PutBase includes a CRDT message bridge. Connect any CRDT library to a row and all members receive each other's updates in real time.

Sending CRDT updates requires `"writer"` access, but all members can poll and receive them.

Here is the recommended [Yjs](https://yjs.dev) integration:

```ts
import * as Y from "yjs";
import { createYjsBinding } from "@putbase/yjs";
import { useCrdt } from "@putbase/react";

const binding = createYjsBinding(Y);
const { value: doc, flush } = useCrdt(board, binding);

// Write to doc normally, then push immediately when needed
await flush();
```

`@putbase/yjs` uses your app's `yjs` instance instead of bundling its own runtime, which avoids the multi-runtime Yjs failure mode.

---

## Example apps

`packages/todo-app` is the code from this README assembled into a working app — boards, recent boards, cards, and invite links. Run it with:

```bash
pnpm --filter todo-app dev
```

For a fuller picture of how the pieces fit together in a real app, read `packages/woof-app`. It uses CRDT-backed live chat, user-scoped history rows for room restore, child rows with per-user metadata, and role-aware UI — the patterns you'll reach for once basic reads and writes are working.

```bash
pnpm --filter woof-app dev
```

---

## API reference

### `PutBase`

| Method | Description |
|--------|-------------|
| `new PutBase({ schema, appBaseUrl? })` | Create a client. Pass `appBaseUrl` so invite links point back to your app. |
| `ensureReady()` | Explicitly await authentication and provisioning before mutations. Recommended during app startup. |
| `whoAmI()` | Returns `{ username }` for the signed-in Puter user. |
| `put(collection, fields, options?)` | Create a row optimistically and return a `MutationReceipt<RowHandle>` immediately. Pass `{ in: parent }` for child rows, where `parent` can be a `RowHandle` or `RowRef`; for collections declared as `in: ["user"]`, omitting `in` uses the current signed-in user's built-in `user` row. Most apps use `.value`; await `.settled` when you need remote confirmation. |
| `update(collection, row, fields)` | Merge field updates onto a row optimistically and return a `MutationReceipt<RowHandle>` immediately. `row` can be a `RowHandle` or `RowRef`. |
| `getRow(row)` | Fetch a row by typed reference. |
| `query(collection, options)` | Load rows under a parent, with optional index, order, and limit. For collections declared as `in: ["user"]`, omitting `in` uses the current signed-in user's built-in `user` row. |
| `watchQuery(collection, options, callbacks)` | Subscribe to repeated query refreshes via `callbacks.onChange`. For collections declared as `in: ["user"]`, omitting `in` uses the current signed-in user's built-in `user` row. Returns a handle with `.disconnect()`. |
| `createInviteToken(row)` | Generate a new invite token for a row and return a `MutationReceipt<InviteToken>`. Most apps can use `.value` immediately. |
| `getExistingInviteToken(row)` | Return the existing token if one exists, or `null`. |
| `createInviteLink(row, token)` | Build a shareable URL containing a serialized row ref and token. |
| `parseInvite(input)` | Parse an invite URL into `{ ref, inviteToken? }`. |
| `openInvite(input)` | Join a row via invite URL or parsed invite object, and return its handle. Invite joins become direct `"writer"` members by default. |
| `rememberPerUserRow(key, row)` | Persist one current row for the signed-in user under your app-defined key. |
| `openRememberedPerUserRow(key)` | Re-open the remembered row for the signed-in user, or `null`. |
| `clearRememberedPerUserRow(key)` | Remove the remembered row for the signed-in user. |
| `listMembers(row)` | Returns `string[]` of all member usernames. |
| `listDirectMembers(row)` | Returns `{ username, role }[]` for direct members. |
| `listEffectiveMembers(row)` | Returns resolved membership including grants inherited from parents. |
| `addMember(row, username, role)` | Grant a user access and return a `MutationReceipt<void>`. Roles: `"writer"` and `"reader"`. `"writer"` can update fields, manage members, manage parents, and send CRDT messages; `"reader"` is read-only. |
| `removeMember(row, username)` | Revoke a user's access and return a `MutationReceipt<void>`. |
| `addParent(child, parent)` | Link a row to an additional parent after creation and return a `MutationReceipt<void>`. |
| `removeParent(child, parent)` | Unlink a row from a parent and return a `MutationReceipt<void>`. |
| `listParents(child)` | Returns all parent references for a row. |
| `connectCrdt(row, callbacks)` | Bridge a CRDT onto the row's message stream. Returns a `CrdtConnection`. |

### `RowHandle`

| Member | Description |
|--------|-------------|
| `.fields` | Current field snapshot, typed from your schema. Treat it as read-only; the object is replaced when fields change. |
| `.collection` | The collection this row belongs to. |
| `.ref` | Portable `RowRef` object for persistence, invites, ref-typed fields, and reopening the row later. |
| `.id` / `.owner` | Row identity metadata. |
| `.refresh()` | Re-fetch fields from the server. Resolves to the latest field snapshot. |
| `.connectCrdt(callbacks)` | Shorthand for `db.connectCrdt(row, callbacks)`. |
| `.in.add(parent)` / `.in.remove(parent)` / `.in.list()` | Manage parent links. |
| `.members.add(username, { role })` / `.members.remove(username)` / `.members.list()` | Manage membership. |

### `MutationReceipt<T>`

| Member | Description |
|--------|-------------|
| `.value` | The optimistic value available immediately. For `put` and `update`, this is the `RowHandle`. |
| `.settled` | Promise that resolves to the final value once the write is confirmed remotely. Rejects if the write fails. |
| `.status` | Current write status: `"pending"`, `"settled"`, or `"failed"`. |
| `.error` | The rejection reason after a failed write. Otherwise `undefined`. |
