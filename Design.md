# puter-fed

Monorepo for a Puter-backed federated message room SDK plus a working example app.

## What is in this repo

- `puter-federation-sdk/`: TypeScript SDK and worker template for signed, federated room of messages.
- `woof-app/`: TypeScript SPA that uses the SDK (adopt a dog, chat, invite via link).

## Current design

- Each owner is backed by one Puter worker that manages all of their rooms.
- Writes (`/message`, `/invite-token`) are signed with ECDSA P-256.
- Users publish a public key proof document; worker caches it on join.
- Messages are stored as per-message KV records (not a single append array).
- Invites are token-based links:
  - create token via `POST /invite-token`
  - join with `inviteToken` for non-owner/non-member first join


# puter-federation-sdk

SDK for Puter federated rooms with signed writes (append message), worker-backed persistence, and invite tokens.

## Core design

- One owner = one deployed worker endpoint. Each room is addressed under `/rooms/:roomId` on that worker. Puter workers use classic script files, not ES modules, and you access kv through globals. Read examples carefully. Use puter router routes, so you can add options to add CORS headers for the endpoints clients hit.
- Room data is stored in owner KV under `room:{roomId}:*`.
- Members join by submitting username + + public-key URL.
- Worker verifies signatures for writes and ignores client identity claims unless verified.

### Storage model

- `room:{roomId}:meta` -> `{ id, name, owner, createdAt }`
- `room:{roomId}:members` -> `string[]`
- `room:{roomId}:parent_rooms` -> `string[]` (worker URLs of parent rooms)
- `room:{roomId}:worker_url` -> `string`
- `room:{roomId}:memberkey:{username}` -> public key JWK
- `room:{roomId}:message:{createdAt}:{messageId}` -> message object
- `room:{roomId}:invite_token:{token}` -> invite token object

### Message shape

```js
{
  id,
  roomId,
  body,
  createdAt,
  signedBy,
  sequence, // assigned by worker
}
```

### Invite token shape (no expiration yet, but ready for it)

```js
{
  token,
  roomId,
  invitedBy,
  createdAt,
}
```

## Public API

```js
import { PuterFedRooms } from 'puter-federation-sdk';

const rooms = new PuterFedRooms();
await rooms.ensureReady();

const room = await rooms.createRoom('Rex');

const invite = await rooms.createInviteToken(room);
// invite.inviteToken

const joinedRoom = await rooms.joinRoom(room.url, {
  inviteToken: invite.inviteToken,
});

await rooms.sendMessage(room, 'hello');
const messages = await rooms.pollMessages(room, 0);
```

### Methods

- `ensureReady()`
- `whoAmI()`
- `createRoom(name)`
- `joinRoom(workerUrl, { inviteToken?, publicKeyUrl })`
- `createInviteToken(room)`
- `listMembers(room)`
- `sendMessage(room, body)`
- `pollMessages(room, sinceSequence)`
- `listParentRooms(room)` — deferred, coming with UI changes
- `setParentRooms(room, parentWorkerUrls)` — deferred, coming with UI changes

## Worker endpoints

- `POST /rooms` — create room metadata (`roomId`, `roomName`) on the owner worker
- `GET /rooms/:roomId/room` — returns room snapshot including `members` and `parentRooms`
- `GET /rooms/:roomId/messages?sinceSequence=...`
- `GET /rooms/:roomId/is-member?ttl=N` — returns `{ isMember: true }` (200) or 401; checks parent rooms recursively up to TTL hops (default 5)
- `POST /rooms/:roomId/join`
- `POST /rooms/:roomId/invite-token`
- `POST /rooms/:roomId/message`

### Parent rooms

A room can declare other rooms as "parents" by storing their worker URLs in `room:{roomId}:parent_rooms`. Any member of a parent room is treated as a member of the child room. Membership checks fan out concurrently to all parent worker URLs via `puter.workers.exec` (which propagates the current user's identity). The TTL param on `/is-member` bounds recursion depth to prevent infinite cycles.

# woof-app

TypeScript single-page app built on `puter-federation-sdk` and vite.

## Product behavior

- User signs in with Puter.
- First use: adopt a dog -> creates new room and stores local profile (`woof:myDog`).
- Returning user: auto-restores from local profile.
- User message flow:
  1. send signed user message (a JSON with {"userType": "user", "content":...})
  2. generate dog reply via `puter.ai.chat()` (the return value is response.message.content, look at an example)
  3. send signed dog-role message  (a JSON with {"userType": "dog", "content":...})
- Polling refresh every 5s.

## Invite model

- No username invite field.
- Invite link is auto-generated when entering chat.
- Link format avoids embedding the full worker URL in query params.
- Chat includes a `Copy link` button.
- Join input accepts:
  - app invite link
  - worker URL with `?token=...`
  - plain worker URL (works for owner/existing members)

## Relinquish flow

- `Relinquish Dog` button clears local profile and `woof:myDog`.
- Stops polling, clears local chat state, returns to setup UI.
- Does not delete remote room/messages/members.

## Non-goals

- Invite token expiration/revocation/max-use not enforced yet.
- No push notifications; polling only.
