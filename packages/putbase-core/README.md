# PutBase

**A multi-user database for apps that have no backend.**

PutBase is a TypeScript SDK that gives your web app collaborative, multi-user data storage — without you ever running a server. Users sign in with their [Puter](https://puter.com) accounts. Their data lives in their Puter storage. You write a schema, call `put` and `query`, share invite links, and you're done.

This makes PutBase particularly well-suited for:

- **Hobbyists and open-source projects** — no infrastructure to run or pay for
- **Apps built by AI coding agents** — the explicit-grant access model is simple enough that even a small-context agent can reason about it correctly
- **Apps with user-pays AI** — Puter provides AI APIs billed to the user's own account, so you can build AI-powered features with zero hosting cost and a single login flow

```ts
// Write
const board = await db.put("boards", { title: "Launch checklist" });
await db.put("cards", { text: "Ship it", done: false, createdAt: Date.now() }, { in: board });

// Read (React)
const { rows: cards } = useQuery<Schema, "cards">(db, "cards", {
  in: board,
  index: "byCreatedAt",
  order: "asc",
});

// Share
const { data: inviteLink } = useInviteLink(db, board);
```

---

## How it works

Every piece of data in PutBase is a **row**. A row belongs to a **collection** defined in your schema, holds typed fields, and has its own identity and access control. You get a `RowHandle` when you create or fetch a row — that handle is your entry point for reading fields, sharing the row, and subscribing to real-time updates.

Rows can be nested. A collection can declare that its rows live **inside** a parent collection: a `card` lives inside a `board`, a `comment` lives inside a `post`. The parent relationship constrains who can see child rows — gaining access to a parent automatically makes the children visible too.

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
  cards: collection({
    in: ["boards"],           // cards live inside boards
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

- `collection({ in: [...] })` — `in` lists the allowed parent collections; omit it for top-level rows
- `field.string()` / `.number()` / `.boolean()` / `.date()` / `.json()` — typed fields; chain `.optional()` or `.default(value)` as needed
- `index(fieldName)` — makes a field queryable with ordering and range filters

---

## Setup

Create one `PutBase` instance for your app and pass it an `appBaseUrl` so that invite links point back to your app:

```ts
import { PutBase } from "@putbase/core";
import { schema } from "./schema";

export const db = new PutBase({ schema, appBaseUrl: window.location.origin });
```

Construction is safe on first paint: PutBase may probe whether a session already exists, but it will never open the Puter login popup unless you call `db.signIn()` explicitly.

## Auth and startup

Use `getSession()` to detect whether the current browser already has a Puter session, and call `signIn()` from a user gesture when it does not:

```ts
const session = await db.getSession();

if (session.state === "signed-out") {
  await db.signIn();        // call this from a button click
}
```


---

## Creating rows

```ts
// Create a top-level row
const board = await db.put("boards", { title: "Launch checklist" });

// Create a child row — pass the parent handle directly
await db.put("cards", { text: "Write README", done: false, createdAt: Date.now() }, { in: board });
await db.put("cards", { text: "Publish to npm", done: false, createdAt: Date.now() }, { in: board });
```

`put` returns a `RowHandle` with typed `.fields`, and is usable immediately as a parent for child rows.

To update fields on an existing row:

```ts
await db.update("cards", card, { done: true });
```

---

## Querying

### Imperative

```ts
const cards = await db.query("cards", {
  in: board,
  index: "byCreatedAt",
  order: "asc",
  limit: 50,
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

`rows` is always a typed array — never `undefined`. Other hooks in `@putbase/react`: `useRow`, `useCurrentUser`, `useInviteLink`, `useInviteFromLocation`, `useMemberUsernames`, `useDirectMembers`, `useMutation`.


For app boot, prefer `useSession(db)`:

```tsx
import { useSession } from "@putbase/react";

function AppShell() {
  const session = useSession(db);

  if (session.status === "loading") {
    return <p>Checking session…</p>;
  }

  if (session.session.state === "signed-out") {
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
const token = await db.createInviteToken(board);

// 2. Build a link the recipient can open in their browser
const link = db.createInviteLink(board, token.token);
// → "https://yourapp.com/?target=...&token=..."

// 3. Recipient opens the link; your app calls openInvite
const board = await db.openInvite(link);
```

`openInvite` accepts either a full invite URL (including the one in `window.location.href` when the user lands on your page) or a pre-parsed `{ target, inviteToken? }` object from `db.parseInvite(input)`.

In React apps, `useInviteFromLocation(db, ...)` wraps the common invite-landing flow: detect the current invite URL, wait for session resolution, call `openInvite`, and optionally clear the invite params from the address bar after success.

Users who join through an invite token are added as direct `"writer"` members by default. `"reader"` members can view rows but cannot call `update()` or send CRDT messages.

---

## Membership

Once users have joined a row you can inspect and manage the member list:

```ts
// Flat list of usernames
const members = await db.listMembers(board);

// With roles
const detailed = await db.listDirectMembers(board);
// → [{ username: "alice", role: "owner" }, ...]

// Add or remove manually
await db.addMember(board, "bob", "writer");
await db.removeMember(board, "eve");
```

Membership inherited through a parent row is visible via `listEffectiveMembers`.

---

## Real-time sync (CRDT)

PutBase includes a CRDT message bridge. Connect any CRDT library to a row and all members receive each other's updates in real time.

Sending CRDT updates requires `"writer"` or `"admin"` access, but all members can poll and receive them.

Here is the full integration with [Yjs](https://yjs.dev):

```ts
import * as Y from "yjs";

const doc = new Y.Doc();
let pending: Uint8Array | null = null;

doc.on("update", (update: Uint8Array) => {
  pending = pending ? Y.mergeUpdates([pending, update]) : update;
});

const connection = board.connectCrdt({
  applyRemoteUpdate: (body) => {
    const update = decodeUpdate(body);   // your decode helper
    if (update) Y.applyUpdate(doc, update);
  },
  produceLocalUpdate: () => {
    const next = pending;
    pending = null;
    return next ? encodeUpdate(next) : null;  // your encode helper
  },
});

// Push local changes immediately
await connection.flush();

// Clean up when done
connection.disconnect();
```

---

## Example app

`packages/todo-app` in this repository is a working React app built entirely from the code shown above. It lets users create a board, add cards, check them off, and share the board with others via invite link. Run it with:

```bash
pnpm --filter todo-app dev
```

---

## API reference

### `PutBase`

| Method | Description |
|--------|-------------|
| `new PutBase({ schema, appBaseUrl? })` | Create a client. Pass `appBaseUrl` so invite links point back to your app. |
| `ensureReady()` | Explicitly await authentication and provisioning. Optional — all operations wait for readiness automatically. |
| `whoAmI()` | Returns `{ username }` for the signed-in Puter user. |
| `put(collection, fields, options?)` | Create a row. Pass `{ in: parentHandle }` for child rows. Returns a `RowHandle`. |
| `update(collection, row, fields)` | Merge field updates onto a row. Returns a refreshed `RowHandle`. |
| `getRow(collection, row)` | Fetch a row by typed reference. |
| `query(collection, options)` | Load rows under a parent, with optional index, order, and limit. |
| `watchQuery(collection, options, callbacks)` | Subscribe to repeated query refreshes via `callbacks.onChange`. Returns a handle with `.disconnect()`. |
| `createInviteToken(row)` | Generate a new invite token for a row. |
| `getExistingInviteToken(row)` | Return the existing token if one exists, or `null`. |
| `createInviteLink(row, token)` | Build a shareable URL containing the row target and token. |
| `parseInvite(input)` | Parse an invite URL or worker URL into `{ target, inviteToken? }`. |
| `openInvite(input)` | Join a row via invite URL or parsed invite object, and return its handle. Invite joins become direct `"writer"` members by default. |
| `listMembers(row)` | Returns `string[]` of all member usernames. |
| `listDirectMembers(row)` | Returns `{ username, role }[]` for directly-granted members. |
| `listEffectiveMembers(row)` | Returns resolved membership including grants inherited from parents. |
| `addMember(row, username, role)` | Grant a user access. Roles: `"owner"`, `"writer"`, `"reader"`. `"writer"` and `"admin"` can update fields and send CRDT messages; `"reader"` is read-only. |
| `removeMember(row, username)` | Revoke a user's access. |
| `addParent(child, parent)` | Link a row to an additional parent after creation. |
| `removeParent(child, parent)` | Unlink a row from a parent. |
| `listParents(child)` | Returns all parent references for a row. |
| `connectCrdt(row, callbacks)` | Bridge a CRDT onto the row's message stream. Returns a `CrdtConnection`. |

### `RowHandle`

| Member | Description |
|--------|-------------|
| `.fields` | Current field values, typed from your schema. |
| `.collection` | The collection this row belongs to. |
| `.target` | Stable URL for this row — safe to persist and restore across sessions. |
| `.id` / `.owner` | Row identity components. |
| `.refresh()` | Re-fetch fields from the server. Returns `this`. |
| `.toRef()` | Plain `{ id, owner, target, collection }` reference, useful for serialisation. |
| `.connectCrdt(callbacks)` | Shorthand for `db.connectCrdt(row, callbacks)`. |
| `.in.add(parent)` / `.in.remove(parent)` / `.in.list()` | Manage parent links. |
| `.members.add(username, { role })` / `.members.remove(username)` / `.members.list()` | Manage membership. |
