import { PutBaseError, toApiError } from "./errors";
import { resolveBackend } from "./backend";
import type { WorkersHandler } from "@heyputer/puter.js";
import type { PutBaseOptions } from "./putbase";
import type { BackendClient } from "./types";
import type { DbRowLocator } from "./schema";

function resolveBoundWorkersExec(
  workers: Partial<Pick<WorkersHandler, "exec">> | null | undefined,
): WorkersHandler["exec"] | null {
  if (!workers || typeof workers.exec !== "function") {
    return null;
  }

  return workers.exec.bind(workers);
}

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

  resolveWorkersExec(): WorkersHandler["exec"] | null {
    this.backend = resolveBackend(this.backend);
    return resolveBoundWorkersExec(this.backend?.workers)
      ?? resolveBoundWorkersExec(resolveBackend()?.workers);
  }

  createId(prefix: string): string {
    const random = crypto.randomUUID().replace(/-/g, "");
    return `${prefix}_${random}`;
  }
}
