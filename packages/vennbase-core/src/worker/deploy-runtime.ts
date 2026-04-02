import { RowWorker, type WorkerKv } from "./core.js";
import type { Auth, KV, Puter, WorkersHandler } from "@heyputer/puter.js";

type DeployRuntimeKv = Pick<KV, "get" | "set" | "incr" | "list" | "del">;

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

const ROW_OWNER = "__PUTER_FED_ROW_OWNER__";
const ROW_OWNER_PUBLIC_KEY_JWK = JSON.parse("__VENNBASE_OWNER_PUBLIC_KEY_JWK__");

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
    return me.puter.kv.del(key).then(() => undefined);
  },
  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries = await me.puter.kv.list(prefix, true);
    return Array.isArray(entries) ? entries : [];
  },
};

const worker = new RowWorker(
  {
    owner: ROW_OWNER,
    ownerPublicKeyJwk: ROW_OWNER_PUBLIC_KEY_JWK,
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

router.options("/rows", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/row/get", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/row/join", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/sync/poll", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/invite-token/get", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/invite-token/create", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/sync/send", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/members/is-member", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/members/role", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/fields/get", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/fields/set", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/parents/register-child", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/parents/unregister-child", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/parents/update-index", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/parents/list", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/db/query", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/parents/link-parent", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/parents/unlink-parent", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/members/add", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/members/remove", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/members/direct", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.options("/rows/:rowId/members/effective", () =>
  new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
router.post("/rows", route);
router.post("/rows/:rowId/row/join", route);
router.post("/rows/:rowId/row/get", route);
router.post("/rows/:rowId/sync/poll", route);
router.post("/rows/:rowId/members/is-member", route);
router.post("/rows/:rowId/members/role", route);
router.post("/rows/:rowId/fields/get", route);
router.post("/rows/:rowId/fields/set", route);
router.post("/rows/:rowId/db/query", route);
router.post("/rows/:rowId/members/direct", route);
router.post("/rows/:rowId/members/effective", route);
router.post("/rows/:rowId/invite-token/get", route);
router.post("/rows/:rowId/invite-token/create", route);
router.post("/rows/:rowId/sync/send", route);
router.post("/rows/:rowId/parents/register-child", route);
router.post("/rows/:rowId/parents/unregister-child", route);
router.post("/rows/:rowId/parents/update-index", route);
router.post("/rows/:rowId/parents/list", route);
router.post("/rows/:rowId/parents/link-parent", route);
router.post("/rows/:rowId/parents/unlink-parent", route);
router.post("/rows/:rowId/members/add", route);
router.post("/rows/:rowId/members/remove", route);
