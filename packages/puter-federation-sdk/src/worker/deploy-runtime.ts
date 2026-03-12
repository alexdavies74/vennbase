import { RoomWorker, type WorkerKv } from "./core";

declare const me: {
  puter: {
    kv: {
      get<T = unknown>(key: string): Promise<T | null>;
      set<T = unknown>(key: string, value: T): Promise<void>;
      incr(key: string, amount?: number): Promise<number>;
      delete?(key: string): Promise<void>;
      list(prefix: string, includeValues?: boolean): Promise<Array<{ key: string; value: unknown }> | null>;
    };
    workers?: {
      exec: (url: string, init?: RequestInit) => Promise<Response>;
    };
  };
};

declare const router: {
  options(path: string, handler: () => Response | Promise<Response>): void;
  get(path: string, handler: (ctx: RouterContext) => Response | Promise<Response>): void;
  post(path: string, handler: (ctx: RouterContext) => Response | Promise<Response>): void;
};

interface RouterUserContext {
  username: string;
  puter: {
    getUser?: () => Promise<{ username?: string } | null>;
    auth?: {
      whoami?: () => Promise<{ username?: string } | null>;
      getUser?: () => Promise<{ username?: string } | null>;
    };
    workers?: {
      exec: (url: string, init?: RequestInit) => Promise<Response>;
    };
  };
}

interface RouterContext {
  request: Request;
  user: RouterUserContext;
}

const ROOM_OWNER = "__PUTER_FED_ROOM_OWNER__";
const ROOM_WORKER_URL = "__PUTER_FED_ROOM_WORKER_URL__";

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-username,puter-auth",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const kv: WorkerKv = {
  get<T = unknown>(key: string): Promise<T | null> {
    return me.puter.kv.get<T>(key);
  },
  set<T = unknown>(key: string, value: T): Promise<void> {
    return me.puter.kv.set<T>(key, value);
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
    workerUrl: ROOM_WORKER_URL,
  },
  { kv },
);

async function resolveRequesterFromAuth(user?: RouterUserContext): Promise<string | null> {
  if (!user) {
    return null;
  }

  if (typeof user.username === "string" && user.username) {
    return user.username;
  }

  let candidate: { username?: string } | null = null;
  if (user.puter?.getUser) {
    candidate = await user.puter.getUser().catch(() => null);
  }

  if (!candidate?.username && user.puter?.auth?.getUser) {
    candidate = await user.puter.auth.getUser().catch(() => candidate);
  }

  if (!candidate?.username && user.puter?.auth?.whoami) {
    candidate = await user.puter.auth.whoami().catch(() => candidate);
  }

  return candidate?.username ?? null;
}

function withRequesterHeader(request: Request, requester: string | null): Request {
  if (!requester) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("x-puter-username", requester);
  return new Request(request, { headers });
}

async function route({ request, user }: RouterContext): Promise<Response> {
  const requester = await resolveRequesterFromAuth(user);
  const workersExec = user.puter?.workers?.exec ?? me.puter.workers?.exec;
  return worker.handle(withRequesterHeader(request, requester), {
    workersExec: workersExec
      ? (url, init) => workersExec(url, init)
      : (url, init) => fetch(url, init),
  });
}

router.options("/rooms", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/room", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/messages", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/join", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/invite-token", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/message", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/is-member", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/member-role", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rooms/:roomId/fields", () =>
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
router.get("/rooms/:roomId/room", route);
router.get("/rooms/:roomId/messages", route);
router.get("/rooms/:roomId/is-member", route);
router.get("/rooms/:roomId/member-role", route);
router.get("/rooms/:roomId/fields", route);
router.get("/rooms/:roomId/db-query", route);
router.get("/rooms/:roomId/members-direct", route);
router.get("/rooms/:roomId/members-effective", route);
router.post("/rooms/:roomId/join", route);
router.post("/rooms/:roomId/invite-token", route);
router.post("/rooms/:roomId/message", route);
router.post("/rooms/:roomId/fields", route);
router.post("/rooms/:roomId/register-child", route);
router.post("/rooms/:roomId/unregister-child", route);
router.post("/rooms/:roomId/update-index", route);
router.post("/rooms/:roomId/link-parent", route);
router.post("/rooms/:roomId/unlink-parent", route);
router.post("/rooms/:roomId/members-add", route);
router.post("/rooms/:roomId/members-remove", route);
