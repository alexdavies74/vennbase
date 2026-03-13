# puter-federation-sdk

`puter-federation-sdk` is a TypeScript SDK for building Puter-backed collaborative apps around typed rows. It handles worker provisioning, row creation and lookup, parent-child relationships, membership, invite links, and CRDT message sync behind a single `PutBase` client.

## Install

```bash
pnpm add puter-federation-sdk
```

## Core API

Create one `PutBase` instance with your schema, then call `ensureReady()` before relying on provisioned worker-backed operations.

```ts
import { PutBase, collection, defineSchema, field, index } from "puter-federation-sdk";
import { puter } from "@heyputer/puter.js";

const schema = defineSchema({
  dogs: collection({
    fields: {
      name: field.string(),
    },
  }),
  tags: collection({
    in: ["dogs"],
    fields: {
      label: field.string(),
      createdAt: field.number(),
    },
    indexes: {
      byCreatedAt: index("createdAt"),
    },
  }),
});

const db = new PutBase({
  puter,
  appBaseUrl: window.location.origin,
  schema,
});

await db.ensureReady();

const dog = await db.put("dogs", { name: "Rex" });
await db.put("tags", { label: "friendly", createdAt: Date.now() }, { in: dog.toRef() });

const tags = await db.query("tags", {
  in: dog.toRef(),
  index: "byCreatedAt",
  order: "asc",
  limit: 100,
});
```

## Schema DSL

- `defineSchema(...)` declares the full database shape.
- `collection(...)` defines one row collection.
- `field.string()`, `field.number()`, `field.boolean()`, `field.date()`, and `field.json()` define typed fields.
- `index(...)` defines queryable indexes.

Parent constraints are expressed with `in: [...]` on a collection. That drives type-safe `put`, parent links, and query options.

## Working With Rows

- `ensureReady()` authenticates the current user and ensures their federation worker is available.
- `whoAmI()` returns the current Puter username.
- `put(collection, fields, options)` creates a row and returns a `RowHandle`.
- `update(collection, row, fields)` updates stored fields and returns a refreshed `RowHandle`.
- `getRow(collection, row)` fetches a known row by typed reference.
- `getRowByUrl(workerUrl)` fetches a row when all you have is its worker URL.
- `query(collection, options)` loads rows under a parent with optional index selection, filtering, ordering, and limits.
- `watchQuery(collection, options, callbacks)` subscribes to repeated query refreshes.

`RowHandle` exposes the row identity, current fields, `toRef()`, `refresh()`, membership helpers, parent-link helpers, and `connectCrdt(...)`.

## Collaboration Features

- `getExistingInviteToken(row)` and `createInviteToken(row)` manage invite tokens for a row.
- `createInviteLink(row, inviteToken)` builds an app link that can be shared with another user.
- `parseInviteInput(input)` accepts app invite links or direct worker URLs with an optional `token`.
- `joinRow(workerUrl, { inviteToken })` joins a shared row and returns its handle.
- `listMembers(row)`, `listDirectMembers(row)`, and `listEffectiveMembers(row)` expose room membership.
- `addMember(...)` and `removeMember(...)` manage direct membership roles.
- `addParent(...)`, `removeParent(...)`, and `listParents(...)` manage parent-child relationships between rows.
- `connectCrdt(row, callbacks)` bridges CRDT updates onto the row message stream.

## Provisioning Model

The SDK provisions one federation worker per user per app host. `PutBase` handles worker discovery, deployment, and room URL routing internally. Consumers work with rows and row URLs; worker runtime classes are internal implementation details and are not part of the package API.

## Export Surface

The supported root exports are:

- `PutBase`
- `RowHandle`
- `PuterFedError`
- `collection`, `defineSchema`, `field`, `index`
- `PutBaseOptions`
- `CrdtConnectCallbacks`, `CrdtConnection`, `DeployWorkerArgs`, `InviteToken`, `JsonValue`, `ParsedInviteInput`, `BackendClient`, `RoomUser`
- Schema and query helper types such as `DbRowRef`, `DbQueryOptions`, `DbQueryWatchHandle`, `MemberRole`, and `RowFields`
