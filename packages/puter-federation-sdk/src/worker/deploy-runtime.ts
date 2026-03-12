import { RoomWorker, type WorkerKv } from "./core";

declare const me: {
  puter: {
    kv: {
      get<T = unknown>(key: string): Promise<T | null>;
      set<T = unknown>(key: string, value: T): Promise<void>;
      incr(key: string, amount?: number): Promise<number>;
      list(prefix: string, includeValues?: boolean): Promise<Array<{ key: string; value: unknown }> | null>;
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

const ROOM_ID = "__PUTER_FED_ROOM_ID__";
const ROOM_NAME = "__PUTER_FED_ROOM_NAME__";
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
  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries = await me.puter.kv.list(prefix, true);
    return Array.isArray(entries) ? entries : [];
  },
};

const worker = new RoomWorker(
  {
    roomId: ROOM_ID,
    roomName: ROOM_NAME,
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
  return worker.handle(withRequesterHeader(request, requester), {
    workersExec: (url, init) => user.puter!.workers!.exec(url, init)
  });
}

router.options("/room", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/messages", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/join", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/invite-token", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/message", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/is-member", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.get("/room", route);
router.get("/messages", route);
router.get("/is-member", route);
router.post("/join", route);
router.post("/invite-token", route);
router.post("/message", route);
