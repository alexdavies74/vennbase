<p align="center">
  <img src="./assets/mark.svg" alt="Vennbase mark" width="180" />
</p>

# Vennbase

**Build multi-user apps without writing a single access rule.**

Vennbase is a TypeScript client-side database for **collaborative**, local-first web apps. It frees developers from running a backend, paying for servers, or writing finnicky access control rules. Users sign up for a [Puter](https://puter.com) account to store their data. Your app sees the subset of the data shared with a user.

```tsx
// Write
const board = db.create("boards", { title: "Launch checklist" }).value;
db.create("cards", { text: "Ship it", done: false, createdAt: Date.now() }, { in: board });

// Read (React)
const { rows: cards = [] } = useQuery(db, "cards", {
  in: board,
  orderBy: "createdAt",
  order: "asc",
});

// Share
const { shareLink } = useShareLink(db, board, "all-editor");
```

Write your frontend. Vennbase handles the rest.

- **User brings standardized backend** — no server to run, no infrastructure bill
- **No access rules to write** — share a link, they're in; that's the whole model
- **Optimistic updates** — instant writes built-in
- **Local-first support** — app data syncs via CRDT automatically
- **NoSQL, open source**
- **Auth, server functions** — via Puter, one login for your whole app
- **User-pays AI** — Puter's AI APIs are billed to the user, not you; build AI features with zero hosting cost
- **Agent-friendly** — the explicit-grant model is simple enough that AI coding agents get it right first time

---

## How it works

Every piece of data in Vennbase is a **row**. A row belongs to a **collection** defined in your schema, holds typed fields, and has its own identity.

Rows can be **nested**. A `card` lives inside a `board`; a `recentBoard` lives inside the built-in `user` collection. Parent links define query scope and visibility: gaining access to a parent automatically grants access to its children.

Access is **explicit-grant only**. To let someone into a row, generate a share link and send it to them. They accept it, they're in. There are no rule expressions to write and no policy surface to misconfigure.

---

## Vennbase documentation

| Document | Description |
|----------|-------------|
| [`packages/todo-app`](https://github.com/alexdavies74/vennbase/tree/main/packages/todo-app) | Small working board-and-cards app mirrored by this README. |
| [`PATTERNS.md`](https://github.com/alexdavies74/vennbase/blob/main/packages/vennbase-core/PATTERNS.md) | Recipe-style app patterns for blind inboxes, index-key projections, resource claims, and other real-world Vennbase designs. |

---

## Install

```bash
pnpm add @vennbase/core
```

React apps: `pnpm add @vennbase/react @vennbase/core`.

---

## Schema

Define your collections once. TypeScript infers field types throughout the SDK automatically.

```ts
import { collection, defineSchema, field } from "@vennbase/core";

export const schema = defineSchema({
  boards: collection({
    fields: {
      title: field.string(),
    },
  }),
  recentBoards: collection({
    in: ["user"],
    fields: {
      boardRef: field.ref("boards").indexKey(),
      openedAt: field.number().indexKey(),
    },
  }),
  cards: collection({
    in: ["boards"],
    fields: {
      text: field.string(),
      done: field.boolean(),
      createdAt: field.number().indexKey(),
    },
  }),
});

export type Schema = typeof schema;
```

- `collection({ in: [...] })` — `in` lists the allowed parent collections.
- `field.string()` / `.number()` / `.boolean()` / `.date()` / `.ref(collection)` — typed fields; chain `.indexKey()`, `.optional()`, or `.default(value)` as needed

Fields are for metadata that you want to query. Mark fields with `.indexKey()` when they should be stored in the parent query index.

Only `.indexKey()` fields can be used in `where` and `orderBy`.

Important: `select: "indexKeys"` returns a projection of only `.indexKey()` fields. Before adding `.indexKey()`, assume submitters with index-key-query access may read that field.

The canonical CRDT pattern is: row fields hold metadata and row refs, while the CRDT document holds the collaborative value state for that row.

---

## Setup

Create one `Vennbase` instance for your app and pass it an `appBaseUrl` so that share links point back to your app:

```ts
import { Vennbase } from "@vennbase/core";
import { schema } from "./schema";

export const db = new Vennbase({ schema, appBaseUrl: window.location.origin });
```

## Auth and startup

```tsx
import { useSession } from "@vennbase/react";

function AppShell() {
  const session = useSession(db);
  const signedIn = session.status === "success" && session.data?.signedIn === true;

  if (session.status === "loading") {
    return <p>Checking session…</p>;
  }

  if (!signedIn) {
    return <button onClick={() => void session.signIn()}>Log in with Puter</button>;
  }

  return <App />;
}
```


---

## Creating rows

```ts
// Create a top-level row
const board = db.create("boards", { title: "Launch checklist" }).value;

// Create a child row — pass the parent row or row ref
db.create("cards", { text: "Write README", done: false, createdAt: Date.now() }, { in: board });
db.create("cards", { text: "Publish to npm", done: false, createdAt: Date.now() }, { in: board });
```

`create` and `update` are synchronous optimistic writes. In normal app code, use `.value` on the returned receipt when you want the row handle immediately. Only await `.committed` when another client must be able to rely on the write right away, or when you explicitly need remote confirmation.

To update fields on an existing row:

```ts
db.update("cards", card, { done: true });
```

---

## Querying

Vennbase queries always run within a known scope. For `cards`, that scope is a `board`, so you pass `in: board`. For collections declared as `in: ["user"]`, pass `in: CURRENT_USER`.

Queries never mean "all accessible rows". `in` is always required, and collections not declared `in` another cannot be queried.

### Imperative

```ts
import { CURRENT_USER } from "@vennbase/core";

const recentBoards = await db.query("recentBoards", {
  in: CURRENT_USER,
  orderBy: "openedAt",
  order: "desc",
  limit: 10,
});
```

```ts
// Multi-parent queries run in parallel, then merge and sort their results
const cards = await db.query("cards", {
  in: [todoBoard, bugsBoard],
  orderBy: "createdAt",
  order: "asc",
  limit: 20,
});
```

### With React

`@vennbase/react` ships a `useQuery` hook that polls for changes and re-renders automatically:

```tsx
import { useQuery } from "@vennbase/react";

const { rows: cards = [], isLoading } = useQuery(db, "cards", {
  in: board,
  orderBy: "createdAt",
  order: "asc",
});
```

### Full rows vs index-key projections

The default query result is a full row handle. Full rows are locatable and reusable: they expose `ref`, `owner`, `fields`, row membership APIs, parent-link APIs, and can be passed back into row workflows.

Index key queries are intentionally weaker:

```ts
const slots = await db.query("bookings", {
  in: bookingRoot,
  select: "indexKeys",
  orderBy: "slotStartMs",
});
```

They return objects shaped like `{ kind: "index-key-projection", id, collection, fields }`, where `fields` contains only values declared `.indexKey()`. These are index-key projections only. They are not row refs, cannot be reopened, and cannot be passed to row-handle APIs.


---

## Sharing rows with share links

Access to a row is always explicit. There is no rule system to misconfigure. A user either holds a valid invite token or they do not.

```tsx
const { shareLink } = useShareLink(db, board, "all-editor");

const incomingInvite = useAcceptInviteFromUrl<Schema, BoardHandle>(db, {
  enabled: board === null,
  onOpen: (nextBoard) => {
    void rememberRecentBoard(nextBoard).catch(console.error);
    setBoard(nextBoard);
  },
});
```


```ts
const editorLink = db.createShareLink(board, "all-editor").value;
const sharedBoard = await db.acceptInvite(editorLink);
```

`acceptInvite` accepts either a full invite URL or a pre-parsed `{ ref, shareToken? }` object from `db.parseInvite(input)`. In React, `useAcceptInviteFromUrl(db, ...)` handles the common invite-landing flow for you.

Role names start with read scope within the row:

- `index-*` can only work with child rows, and not access content.
- `content-*` can also access row content, parents, and sync, but not members.
- `all-*` can access content and inspect members.

and end with write capability:

- `*-viewer` can only read that scope
- `*-submitter` can also add child rows
- `*-editor` can edit anything the role can read.

For blind inbox workflows, create an `index-submitter` link instead:

```ts
const submissionLink = db.createShareLink(board, "index-submitter").value;
const joined = await db.joinInvite(submissionLink);
// joined.role === "index-submitter"
```

`joinInvite` is idempotent, so call it whenever you need it.

`"index-submitter"` members can create child rows under the shared parent and can run `db.query(..., { select: "indexKeys" })` to see only index-key projections from sibling rows. If the app needs durable revisit/edit/cancel flows, the usual pattern is to also link the child into a user-specific join row that the submitter can query later.

---

## Membership

Only `all-*` role members can inspect the member list, and only `all-editor` can revoke direct members:

```ts
// Flat list of usernames
const members = await db.listMembers(board);

// With roles
const detailed = await db.listDirectMembers(board);
// → [{ username: "alice", role: "all-editor" }, ...]

// Grant access by sending an invite link
const editorLink = await db.createShareLink(board, "all-editor").committed;

// Later, revoke an already-joined direct member
await db.removeMember(board, "eve").committed;
```

Membership inherited through a parent row is visible via `listEffectiveMembers`. For app-level "memberships" that need discovery, ordering, or extra metadata, prefer modeling them as rows and parent links instead of username-only grants. A common pattern is sharing a readable parent row with `content-submitter`, then letting each user create their own child join row beneath it.

---

## Real-time sync (CRDT)

Vennbase includes a CRDT message bridge. Connect any CRDT library to a row and all members receive each other's updates in real time.

Sending CRDT updates requires `"content-editor"` or `"all-editor"` access. Any readable role (`content-*` or `all-*`) can poll and receive them.

In React, here is the recommended [Yjs](https://yjs.dev) integration:

```tsx
import * as Y from "yjs";
import { createYjsAdapter } from "@vennbase/yjs";
import { useCrdt } from "@vennbase/react";

const adapter = createYjsAdapter(Y);
const { value: doc, flush } = useCrdt(board, adapter);

// Write to doc normally, then push immediately when needed
await flush();
```

`@vennbase/yjs` uses your app's `yjs` instance instead of bundling its own runtime, which avoids the multi-runtime Yjs failure mode.

---

## Example apps

`packages/todo-app` is the working version of this README — boards, recent boards, cards, and share links. Start with `src/schema.ts`, `src/db.ts`, and `src/App.tsx`. Run it with:

```bash
pnpm --filter todo-app dev
```

For a fuller picture of how the pieces fit together in a real app, read `packages/woof-app`. It uses CRDT-backed live chat, user-scoped history rows for room restore, child rows with per-user metadata, and role-aware UI — the patterns you'll reach for once basic reads and writes are working.

```bash
pnpm --filter woof-app dev
```

`packages/appointment-app` is the clearest example of the Vennbase access-control philosophy in a full app: explicit grants, a blind booking inbox, and minimal anonymous sibling visibility via `select: "indexKeys"`. It demonstrates convergent client-side claim resolution, not hard capacity enforcement. Read [`PATTERNS.md`](./PATTERNS.md) for a recipe-style walkthrough of each pattern.

```bash
pnpm --filter appointment-app dev
```

---

## API reference

### `Vennbase`

| Method | Description |
|--------|-------------|
| `new Vennbase({ schema, appBaseUrl? })` | Create a Vennbase instance. Pass `appBaseUrl` so share links point back to your app. |
| `getSession()` | Check whether the current browser already has a Puter session. |
| `signIn()` | Start the Puter sign-in flow. Call this from a user gesture such as a button click. |
| `whoAmI()` | Returns `{ username }` for the signed-in Puter user. |
| `create(collection, fields, options?)` | Create a row optimistically and return a `MutationReceipt<RowHandle>` immediately. Pass `{ in: parent }` for child rows, where `parent` can be a `RowHandle` or `RowRef`. For user-scoped collections, pass `{ in: CURRENT_USER }`. Most apps use `.value`; await `.committed` when you need remote confirmation. |
| `update(collection, row, fields)` | Merge field updates onto a row optimistically and return a `MutationReceipt<RowHandle>` immediately. `row` can be a `RowHandle` or `RowRef`. |
| `getRow(row)` | Fetch a row by typed reference. |
| `query(collection, options)` | Load rows under a parent, with optional index, order, and limit. Pass `in`, including `CURRENT_USER` for user-scoped collections. Default queries return locatable `RowHandle` values; `select: "indexKeys"` returns non-reopenable index-key projections. |
| `watchQuery(collection, options, callbacks)` | Subscribe to repeated query refreshes via `callbacks.onChange`. Pass `in`, including `CURRENT_USER` for user-scoped collections. Returns a handle with `.disconnect()`. The callback receives either full `RowHandle` values or index-key projections depending on `select`. |
| `createShareToken(row, role)` | Generate a share token optimistically and return a `MutationReceipt<ShareToken>`. `.value` is usable locally right away; await `.committed` before another client must be able to use it. |
| `getExistingShareToken(row, role)` | Return the existing token for the requested role if one exists, or `null`. |
| `createShareLink(row, shareToken)` | Build a shareable URL containing a serialized row ref and token. |
| `createShareLink(row, role)` | Generate a future-valid share link for that role and return it as a `MutationReceipt<string>`. `.value` is the local URL immediately; `.committed` resolves when recipients can rely on it remotely. |
| `parseInvite(input)` | Parse an invite URL into `{ ref, shareToken? }`. |
| `joinInvite(input)` | Idempotently join a row via invite URL or parsed invite object without opening it, and return `{ ref, role }`. |
| `acceptInvite(input)` | Join a readable invite and return its handle. Use it for `content-*` and `all-*` invites. `index-*` invites should use `joinInvite(...)`. |
| `saveRow(key, row)` | Persist one current row for the signed-in user under your app-defined key. |
| `openSavedRow(key, collection)` | Re-open the saved row for the signed-in user as the expected collection, or `null`. Throws if the stored row belongs to a different collection. |
| `clearSavedRow(key)` | Remove the saved row for the signed-in user. |
| `listMembers(row)` | Returns `string[]` of all member usernames. |
| `listDirectMembers(row)` | Returns `{ username, role }[]` for direct members. |
| `listEffectiveMembers(row)` | Returns resolved membership including grants inherited from parents. |
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
| `.members.remove(username)` / `.members.list()` / `.members.effective()` / `.members.listAll()` | Inspect direct/effective membership and revoke direct members. |

### `MutationReceipt<T>`

| Member | Description |
|--------|-------------|
| `.value` | The optimistic value available immediately. For `create` and `update`, this is the `RowHandle`. |
| `.committed` | Promise that resolves to the final value once the write is confirmed remotely. Rejects if the write fails. |
| `.status` | Current write status: `"pending"`, `"committed"`, or `"failed"`. |
| `.error` | The rejection reason after a failed write. Otherwise `undefined`. |
