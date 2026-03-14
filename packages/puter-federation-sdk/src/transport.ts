import { PutBaseError, toApiError } from "./errors";
import { resolveBackend } from "./backend";
import type { PutBaseOptions } from "./putbase";
import type { BackendClient } from "./types";
import type { DbRowLocator } from "./schema";

export type PuterWorkersExec = (
  workerUrl: string,
  init?: RequestInit,
) => Promise<Response>;

export function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, "");
}

export function roomEndpointUrl(
  row: Pick<DbRowLocator, "id" | "workerUrl">,
  endpoint: string,
  searchParams?: URLSearchParams,
): string {
  const workerUrl = new URL(stripTrailingSlash(row.workerUrl));
  const segments = workerUrl.pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");

  if (roomsIndex < 0 || roomsIndex + 1 >= segments.length) {
    throw new Error(
      `Unsupported room worker URL: ${row.workerUrl}. Legacy non-federated room URLs are no longer supported.`,
    );
  }

  const routeRoomId = decodeURIComponent(segments[roomsIndex + 1]);
  if (routeRoomId !== row.id) {
    throw new Error(
      `Room worker URL/id mismatch: ${row.workerUrl} does not match row id ${row.id}.`,
    );
  }

  const prefix = segments.slice(0, roomsIndex + 2).join("/");
  workerUrl.pathname = `/${prefix}/${endpoint}`;

  workerUrl.search = searchParams?.toString() ?? "";
  workerUrl.hash = "";
  return workerUrl.toString();
}

export class Transport {
  private backend: BackendClient | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly getUsername: () => Promise<string>;

  constructor(
    options: Pick<PutBaseOptions, "backend" | "fetchFn">,
    getUsername: () => Promise<string>,
  ) {
    this.backend = resolveBackend(options.backend);
    this.fetchFn = options.fetchFn ?? fetch;
    this.getUsername = getUsername;
  }

  setBackend(backend: BackendClient | undefined): void {
    this.backend = backend;
  }

  async request<T>(
    url: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const workersExec = this.resolveWorkersExec();
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;

    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
      },
      body: serialized,
    };

    const response = workersExec
      ? await workersExec(url, init)
      : await this.requestViaFetch(url, init);

    const payload = await response
      .json()
      .catch((): unknown => ({ code: "BAD_REQUEST", message: response.statusText }));

    this.logWorkerTrace(url, response.status, payload);

    if (!response.ok) {
      throw new PutBaseError(toApiError(payload), response.status);
    }

    return payload as T;
  }

  private async requestViaFetch(url: string, init: RequestInit): Promise<Response> {
    const username = await this.getUsername();
    const headers = new Headers(init.headers);
    headers.set("x-puter-username", username);

    const fetchFn = this.fetchFn;
    return fetchFn(url, {
      ...init,
      headers,
    });
  }

  resolveWorkersExec(): PuterWorkersExec | null {
    this.backend = resolveBackend(this.backend);

    const exec = (this.backend?.workers as { exec?: unknown } | undefined)?.exec;
    if (typeof exec === "function") {
      return exec as PuterWorkersExec;
    }

    const globalBackend = resolveBackend();
    const globalExec = (globalBackend?.workers as { exec?: unknown } | undefined)?.exec;
    return typeof globalExec === "function" ? (globalExec as PuterWorkersExec) : null;
  }

  createId(prefix: string): string {
    const random = crypto.randomUUID().replace(/-/g, "");
    return `${prefix}_${random}`;
  }

  private logWorkerTrace(url: string, status: number, payload: unknown): void {
    const logs = extractLogs(payload);
    if (!logs || logs.length === 0) {
      return;
    }

    console.info(`[putbase] worker trace ${status} ${url}`, logs);
  }
}

function extractLogs(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object" || !("logs" in payload)) {
    return null;
  }

  const candidate = (payload as { logs?: unknown }).logs;
  if (!Array.isArray(candidate)) {
    return null;
  }

  return candidate.filter((entry): entry is string => typeof entry === "string");
}
