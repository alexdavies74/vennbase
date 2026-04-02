import type { AuthManager } from "./auth.js";
import { VennbaseError, toApiError } from "./errors.js";
import { resolveBackend } from "./backend.js";
import type { WorkersHandler } from "@heyputer/puter.js";
import type { VennbaseOptions } from "./vennbase.js";
import type { BackendClient } from "./types.js";
import type { RowRef } from "./schema.js";

type RowAction =
  | "db/query"
  | "fields/get"
  | "fields/set"
  | "invite-token/create"
  | "invite-token/get"
  | "members/add"
  | "members/direct"
  | "members/effective"
  | "members/remove"
  | "parents/link-parent"
  | "parents/register-child"
  | "parents/update-index"
  | "sync/poll"
  | "sync/send"
  | "parents/unlink-parent"
  | "parents/unregister-child"
  | "row/get"
  | "row/join"
  ;

interface RowRequestOptions {
  includeRequestProof?: boolean;
}

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

export function normalizeBaseUrl(input: string): string {
  return stripTrailingSlash(input);
}

export function buildRowUrl(row: Pick<RowRef, "id" | "baseUrl">): string {
  return `${normalizeBaseUrl(row.baseUrl)}/rows/${encodeURIComponent(row.id)}`;
}

function rowEndpointUrl(
  row: Pick<RowRef, "id" | "baseUrl">,
  endpoint: string,
): string {
  const url = new URL(buildRowUrl(row));
  url.pathname = `${url.pathname.replace(/\/+$/g, "")}/${endpoint}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class Transport {
  private backend: BackendClient | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly auth: AuthManager;

  constructor(
    options: Pick<VennbaseOptions, "backend" | "fetchFn">,
    auth: AuthManager,
  ) {
    this.backend = resolveBackend(options.backend);
    this.fetchFn = options.fetchFn ?? fetch;
    this.auth = auth;
  }

  setBackend(backend: BackendClient | undefined): void {
    this.backend = backend;
  }

  async request<T, TPayload = unknown>(args: {
    url: string;
    action: string;
    rowId: string;
    payload: TPayload;
    includeRequestProof?: boolean;
  }): Promise<T> {
    const body = await this.auth.createProtectedRequest({
      action: args.action,
      rowId: args.rowId,
      payload: args.payload,
      includeRequestProof: args.includeRequestProof,
    });
    return this.postJson<T>(args.url, body);
  }

  row(rowRef: Pick<RowRef, "id" | "baseUrl">): {
    request<T, TPayload = unknown>(action: RowAction, payload: TPayload, options?: RowRequestOptions): Promise<T>;
    baseUrl: string;
    rowId: string;
  } {
    const normalizedRow = {
      id: rowRef.id,
      baseUrl: normalizeBaseUrl(rowRef.baseUrl),
    };

    return {
      request: async <T, TPayload = unknown>(
        action: RowAction,
        payload: TPayload,
        options?: RowRequestOptions,
      ): Promise<T> => {
        return this.request<T, TPayload>({
          url: rowEndpointUrl(normalizedRow, action),
          action,
          rowId: normalizedRow.id,
          payload,
          includeRequestProof: options?.includeRequestProof,
        });
      },
      baseUrl: normalizedRow.baseUrl,
      rowId: normalizedRow.id,
    };
  }

  async postJson<T>(
    url: string,
    body: unknown,
  ): Promise<T> {
    const workersExec = this.resolveWorkersExec();
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;

    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-puter-no-auth": "1",
      },
      body: serialized,
    };

    const response = workersExec
      ? await workersExec(url, init)
      : await (() => {
        const fetchFn = this.fetchFn;
        return fetchFn(url, init);
      })();

    const payload = await response
      .json()
      .catch((): unknown => ({ code: "BAD_REQUEST", message: response.statusText }));

    if (!response.ok) {
      throw new VennbaseError(toApiError(payload), response.status);
    }

    return payload as T;
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
