import { RoomWorker, type WorkerKv } from "./core";
import type { Auth, KV, Puter, WorkersHandler } from "@heyputer/puter.js";

type DeployRuntimeKv = Pick<KV, "get" | "set" | "incr" | "list"> & {
  delete?: (key: string) => Promise<void>;
};

type DeployRuntimeWorkers = Pick<WorkersHandler, "exec">;

type DeployRuntimePuter = Pick<Puter, "getUser"> & {
  auth?: Pick<Auth, "whoami" | "getUser">;
  kv: DeployRuntimeKv;
  workers?: DeployRuntimeWorkers;
};

type RouterPuter = Pick<Puter, "getUser"> & {
  auth?: Pick<Auth, "whoami" | "getUser">;
  workers?: DeployRuntimeWorkers;
};

declare const me: {
  puter: DeployRuntimePuter;
};

declare const router: {
  options(path: string, handler: () => Response | Promise<Response>): void;
  get(path: string, handler: (ctx: RouterContext) => Response | Promise<Response>): void;
  post(path: string, handler: (ctx: RouterContext) => Response | Promise<Response>): void;
};

interface RouterUserContext {
  username: string;
  puter: RouterPuter;
}

interface RouterContext {
  request: Request;
  user: RouterUserContext;
}

const ROOM_OWNER = "__PUTER_FED_ROOM_OWNER__";
const ROOM_OWNER_PUBLIC_KEY_JWK = JSON.parse("__PUTBASE_OWNER_PUBLIC_KEY_JWK__");

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-no-auth,puter-auth",
  "access-control-allow-methods": "POST,OPTIONS",
};

const kv: WorkerKv = {
  async get<T = unknown>(key: string): Promise<T | null> {
    return (await me.puter.kv.get<T>(key)) ?? null;
  },
  async set<T = unknown>(key: string, value: T): Promise<void> {
    await me.puter.kv.set<T>(key, value);
  },
  incr(key: string, amount = 1): Promise<number> {
    return me.puter.kv.incr(key, amount);
  },
  delete(key: string): Promise<void> {
    if (typeof me.puter.kv.delete !== "function") {
      return Promise.resolve();
    }

    return me.puter.kv.delete(key);
  },
  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries = await me.puter.kv.list(prefix, true);
    return Array.isArray(entries) ? entries : [];
  },
};

const worker = new RoomWorker(
  {
    owner: ROOM_OWNER,
    ownerPublicKeyJwk: ROOM_OWNER_PUBLIC_KEY_JWK,
  },
  { kv },
);

async function route({ request }: RouterContext): Promise<Response> {
  const workersExec = me.puter.workers?.exec;
  return worker.handle(request, {
    workersExec: workersExec
      ? (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("x-puter-no-auth", "1");
        return workersExec(url, { ...init, headers });
      }
      : (url, init) => fetch(url, init),
  });
}

router.options("/rooms", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/room", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/messages", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/join", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/invite-token/get", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/invite-token/create", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/message", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/is-member", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/member-role", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/fields/get", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/fields/set", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/register-child", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/unregister-child", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/update-index", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/db-query", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/link-parent", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/unlink-parent", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/members-add", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/members-remove", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/members-direct", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/members-effective", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.post("/rooms", route);
router.post("/rooms/:roomId/join", route);
router.post("/rooms/:roomId/room", route);
router.post("/rooms/:roomId/messages", route);
router.post("/rooms/:roomId/is-member", route);
router.post("/rooms/:roomId/member-role", route);
router.post("/rooms/:roomId/fields/get", route);
router.post("/rooms/:roomId/fields/set", route);
router.post("/rooms/:roomId/db-query", route);
router.post("/rooms/:roomId/members-direct", route);
router.post("/rooms/:roomId/members-effective", route);
router.post("/rooms/:roomId/invite-token/get", route);
router.post("/rooms/:roomId/invite-token/create", route);
router.post("/rooms/:roomId/message", route);
router.post("/rooms/:roomId/register-child", route);
router.post("/rooms/:roomId/unregister-child", route);
router.post("/rooms/:roomId/update-index", route);
router.post("/rooms/:roomId/link-parent", route);
router.post("/rooms/:roomId/unlink-parent", route);
router.post("/rooms/:roomId/members-add", route);
router.post("/rooms/:roomId/members-remove", route);
