import { PuterFedError, toApiError } from "./errors";
import type { PuterFedRoomsOptions } from "./types";
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
  private puter: PuterFedRoomsOptions["puter"];
  private readonly fetchFn: typeof fetch;
  private readonly getUsername: () => Promise<string>;

  constructor(
    options: PuterFedRoomsOptions,
    getUsername: () => Promise<string>,
  ) {
    this.puter = options.puter;
    this.fetchFn = options.fetchFn ?? fetch;
    this.getUsername = getUsername;
  }

  setPuter(puter: PuterFedRoomsOptions["puter"]): void {
    this.puter = puter;
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

    if (!response.ok) {
      const maybeApiError = await response
        .json()
        .catch((): unknown => ({ code: "BAD_REQUEST", message: response.statusText }));
      throw new PuterFedError(toApiError(maybeApiError), response.status);
    }

    return (await response.json()) as T;
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
    if (!this.puter) {
      this.puter = (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    }

    const exec = (this.puter?.workers as { exec?: unknown } | undefined)?.exec;
    if (typeof exec === "function") {
      return exec as PuterWorkersExec;
    }

    const globalPuter = (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    const globalExec = (globalPuter?.workers as { exec?: unknown } | undefined)?.exec;
    return typeof globalExec === "function" ? (globalExec as PuterWorkersExec) : null;
  }

  createId(prefix: string): string {
    const random = crypto.randomUUID().replace(/-/g, "");
    return `${prefix}_${random}`;
  }
}
