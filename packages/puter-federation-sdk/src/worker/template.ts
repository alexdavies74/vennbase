function escapeForLiteral(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
}

const CLASSIC_WORKER_TEMPLATE = `
const ROOM_ID = "__ROOM_ID__";
const ROOM_NAME = "__ROOM_NAME__";
const ROOM_OWNER = "__ROOM_OWNER__";
const ROOM_WORKER_URL = "__ROOM_WORKER_URL__";

const CORS_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-username",
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
  return "{" + pairs.join(",") + "}";
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return fromBase64(padded);
}

function roomMetaKey() {
  return "room:" + ROOM_ID + ":meta";
}

function membersKey() {
  return "room:" + ROOM_ID + ":members";
}

function memberKey(username) {
  return "room:" + ROOM_ID + ":memberkey:" + username;
}

function messageKey(message) {
  return "room:" + ROOM_ID + ":message:" + message.createdAt + ":" + message.id;
}

function messagePrefix() {
  return "room:" + ROOM_ID + ":message:";
}

function inviteKey(token) {
  return "room:" + ROOM_ID + ":invite_token:" + token;
}

async function getMembers() {
  return (await me.puter.kv.get(membersKey())) || [];
}

async function ensureMeta() {
  const existing = await me.puter.kv.get(roomMetaKey());
  if (existing) {
    return existing;
  }

  const meta = {
    id: ROOM_ID,
    name: ROOM_NAME,
    owner: ROOM_OWNER,
    workerUrl: ROOM_WORKER_URL,
    createdAt: Date.now(),
  };

  await me.puter.kv.set(roomMetaKey(), meta);
  return meta;
}

async function snapshot() {
  const meta = await ensureMeta();
  const members = await getMembers();
  return { ...meta, members };
}

async function assertMember(username) {
  const members = await getMembers();
  if (!username || !members.includes(username)) {
    throw { status: 401, code: "UNAUTHORIZED", message: "Members only" };
  }
}

function getRequester(request) {
  const requester = request.headers.get("x-puter-username");
  if (!requester) {
    throw { status: 401, code: "UNAUTHORIZED", message: "Missing x-puter-username" };
  }
  return requester;
}

function parseDataUrlJson(dataUrl) {
  const index = dataUrl.indexOf(",");
  if (index < 0 || !dataUrl.slice(0, index).endsWith(";base64")) {
    throw new Error("Invalid data URL");
  }
  const bytes = fromBase64(dataUrl.slice(index + 1));
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

function isJwk(value) {
  return !!value && typeof value === "object" && "kty" in value;
}

async function fetchPublicKeyDoc(publicKeyUrl, username) {
  let payload;

  if (publicKeyUrl.startsWith("data:")) {
    payload = parseDataUrlJson(publicKeyUrl);
  } else {
    const response = await fetch(publicKeyUrl);
    if (!response.ok) {
      throw { status: 400, code: "BAD_REQUEST", message: "Could not fetch public key document" };
    }
    payload = await response.json();
  }

  if (isJwk(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    if (payload.username && payload.username !== username) {
      throw { status: 401, code: "UNAUTHORIZED", message: "Public key username mismatch" };
    }

    if (isJwk(payload.publicKeyJwk)) {
      return payload.publicKeyJwk;
    }
  }

  throw { status: 400, code: "BAD_REQUEST", message: "Public key document format is invalid" };
}

async function verifyEnvelope(envelope, jwk) {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );

  const signedPayload = {
    action: envelope.action,
    payload: envelope.payload,
    signer: envelope.signer,
    signedAt: envelope.signedAt,
    algorithm: "ECDSA_P256_SHA256",
  };

  const canonical = canonicalize(signedPayload);
  const signature = fromBase64Url(envelope.signature);

  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    new TextEncoder().encode(canonical),
  );
}

function sameJwk(left, right) {
  return canonicalize(left) === canonicalize(right);
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    throw { status: 400, code: "BAD_REQUEST", message: "Invalid JSON" };
  }
}

async function handleJoin(request) {
  const body = await parseJson(request);
  if (!body.username || !body.publicKeyUrl) {
    throw { status: 400, code: "BAD_REQUEST", message: "username and publicKeyUrl are required" };
  }

  await ensureMeta();

  const members = await getMembers();
  const alreadyMember = members.includes(body.username);
  const isOwner = body.username === ROOM_OWNER;

  const jwk = await fetchPublicKeyDoc(body.publicKeyUrl, body.username);

  if (alreadyMember) {
    const stored = await me.puter.kv.get(memberKey(body.username));
    if (!stored) {
      throw { status: 401, code: "UNAUTHORIZED", message: "Member key missing" };
    }

    if (!sameJwk(stored, jwk)) {
      throw { status: 409, code: "KEY_MISMATCH", message: "Public key cannot be changed for existing username" };
    }

    return json(200, await snapshot());
  }

  if (!isOwner) {
    if (!body.inviteToken) {
      throw { status: 401, code: "INVITE_REQUIRED", message: "Invite token is required for first join" };
    }

    const invite = await me.puter.kv.get(inviteKey(body.inviteToken));
    if (!invite || invite.roomId !== ROOM_ID) {
      throw { status: 401, code: "INVITE_REQUIRED", message: "Invite token is invalid" };
    }
  }

  members.push(body.username);
  await me.puter.kv.set(membersKey(), members);
  await me.puter.kv.set(memberKey(body.username), jwk);

  return json(200, await snapshot());
}

async function assertSignedWrite(request, envelope, signedBy) {
  const requester = getRequester(request);
  if (requester !== envelope.signer.username) {
    throw { status: 401, code: "UNAUTHORIZED", message: "Requester and signer do not match" };
  }

  if (signedBy !== envelope.signer.username) {
    throw { status: 401, code: "UNAUTHORIZED", message: "Payload signer claim mismatch" };
  }

  await assertMember(envelope.signer.username);

  const jwk = await me.puter.kv.get(memberKey(envelope.signer.username));
  if (!jwk) {
    throw { status: 401, code: "UNAUTHORIZED", message: "Signer key not found" };
  }

  const valid = await verifyEnvelope(envelope, jwk);
  if (!valid) {
    throw { status: 401, code: "INVALID_SIGNATURE", message: "Signature verification failed" };
  }
}

async function handleInviteToken(request) {
  const envelope = await parseJson(request);
  if (!envelope || !envelope.payload) {
    throw { status: 400, code: "BAD_REQUEST", message: "Signed envelope is required" };
  }

  await assertSignedWrite(request, envelope, envelope.payload.invitedBy);

  if (envelope.payload.roomId !== ROOM_ID) {
    throw { status: 400, code: "BAD_REQUEST", message: "Envelope roomId does not match worker room" };
  }

  await me.puter.kv.set(inviteKey(envelope.payload.token), envelope.payload);

  return json(200, { inviteToken: envelope.payload });
}

async function handleMessage(request) {
  const envelope = await parseJson(request);
  if (!envelope || !envelope.payload) {
    throw { status: 400, code: "BAD_REQUEST", message: "Signed envelope is required" };
  }

  await assertSignedWrite(request, envelope, envelope.payload.signedBy);

  if (envelope.payload.roomId !== ROOM_ID) {
    throw { status: 400, code: "BAD_REQUEST", message: "Envelope roomId does not match worker room" };
  }

  await me.puter.kv.set(messageKey(envelope.payload), envelope.payload);
  return json(200, { message: envelope.payload });
}

async function handleRoom(request) {
  const requester = getRequester(request);
  await assertMember(requester);
  return json(200, await snapshot());
}

async function handleMessages(request) {
  const requester = getRequester(request);
  await assertMember(requester);

  const after = Number(new URL(request.url).searchParams.get("after") || "0");
  const entries = await me.puter.kv.list(messagePrefix(), true);

  const messages = entries
    .map((entry) => entry.value)
    .filter((message) => message.createdAt > after)
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));

  return json(200, { messages });
}

function route(handler) {
  return async function ({ request }) {
    try {
      return await handler(request);
    } catch (err) {
      if (err && typeof err === "object" && "status" in err && "code" in err && "message" in err) {
        return json(err.status, { code: err.code, message: err.message });
      }

      return json(500, { code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Unknown server error" });
    }
  };
}

router.options("/room", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
router.options("/messages", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
router.options("/join", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
router.options("/invite-token", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
router.options("/message", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
router.get("/room", route(handleRoom));
router.get("/messages", route(handleMessages));
router.post("/join", route(handleJoin));
router.post("/invite-token", route(handleInviteToken));
router.post("/message", route(handleMessage));
`;

export function buildClassicWorkerScript(args: {
  roomId: string;
  roomName: string;
  owner: string;
  workerUrl: string;
}): string {
  return CLASSIC_WORKER_TEMPLATE.replace("__ROOM_ID__", escapeForLiteral(args.roomId))
    .replace("__ROOM_NAME__", escapeForLiteral(args.roomName))
    .replace("__ROOM_OWNER__", escapeForLiteral(args.owner))
    .replace("__ROOM_WORKER_URL__", escapeForLiteral(args.workerUrl));
}
