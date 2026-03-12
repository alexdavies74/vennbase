import { PuterFedRooms } from "../client";
import { PuterFedError, toApiError } from "../errors";
import { resolveWorkerUrl } from "../invite";
import type { JsonValue, PuterFedRoomsOptions } from "../types";
import { encodeFieldValue } from "./key-encoding";
import { RowHandle, type RowHandleBackend } from "./row-handle";
import type {
  DbCollectionSpec,
  DbInsertOptions,
  DbMemberInfo,
  DbQueryOptions,
  DbRowRef,
  DbSchema,
  MemberRole,
} from "./types";

type PuterWorkersExec = (workerUrl: string, init?: RequestInit) => Promise<Response>;

interface PuterDbOptions<Schema extends DbSchema> extends PuterFedRoomsOptions {
  schema: Schema;
  rooms?: PuterFedRooms;
}

interface DbQueryRow {
  rowId: string;
  owner: string;
  workerUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface DbQueryResponse {
  rows: DbQueryRow[];
}

interface GetFieldsResponse {
  fields: Record<string, JsonValue>;
  collection: string | null;
}

interface ListMembersResponse {
  members: Array<{ username: string; role: MemberRole }>;
}

interface EffectiveMembersResponse {
  members: DbMemberInfo[];
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, "");
}

function parseRoomRefFromWorkerUrl(workerUrl: string): Pick<DbRowRef, "id" | "owner"> {
  const url = new URL(workerUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  const id = roomsIndex >= 0 && roomsIndex + 1 < segments.length
    ? decodeURIComponent(segments[roomsIndex + 1])
    : "";

  const owner = url.hostname.split("-")[0] ?? "";
  return { id, owner };
}

export class PuterDb<Schema extends DbSchema = DbSchema> implements RowHandleBackend {
  private readonly schema: Schema;

  private readonly rooms: PuterFedRooms;

  private puter: PuterFedRoomsOptions["puter"];

  private readonly fetchFn: typeof fetch;

  private readonly workerBaseUrl?: string;

  constructor(private readonly options: PuterDbOptions<Schema>) {
    this.schema = options.schema;
    this.rooms = options.rooms ?? new PuterFedRooms(options);
    this.puter = options.puter ?? (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    this.fetchFn = options.fetchFn ?? fetch;
    this.workerBaseUrl = options.workerBaseUrl;
  }

  async init(): Promise<void> {
    await this.rooms.init();
    if (typeof this.fetchFn !== "function" && !this.resolveWorkersExec()) {
      throw new Error("fetch is required when puter.workers.exec is unavailable");
    }
  }

  async insert(
    collection: keyof Schema & string,
    fields: Record<string, JsonValue>,
    options: DbInsertOptions = {},
  ): Promise<RowHandle> {
    await this.init();

    const collectionSpec = this.getCollectionSpec(collection);
    const parentRefs = this.normalizeParents(options.in);
    this.assertInsertParents(collection, collectionSpec, parentRefs);

    const room = await this.rooms.createRoom(options.name ?? `${collection}-${crypto.randomUUID().slice(0, 8)}`);
    const rowRef: DbRowRef = {
      id: room.id,
      collection,
      owner: room.owner,
      workerUrl: stripTrailingSlash(room.workerUrl),
    };

    const payload = this.applyDefaults(collectionSpec, fields);

    await this.requestRoomJson(`${rowRef.workerUrl}/fields`, "POST", {
      fields: payload,
      collection,
    });

    for (const parent of parentRefs) {
      await this.addParent(rowRef, parent);
    }

    return new RowHandle(this, rowRef, payload);
  }

  async update(
    collection: keyof Schema & string,
    row: string | DbRowRef,
    fields: Record<string, JsonValue>,
  ): Promise<RowHandle> {
    await this.init();
    const rowRef = await this.resolveRowRef(collection, row);
    await this.requestRoomJson(`${rowRef.workerUrl}/fields`, "POST", {
      fields,
      merge: true,
      collection,
    });

    return this.getRow(collection, rowRef);
  }

  async getRow(collection: keyof Schema & string, row: string | DbRowRef): Promise<RowHandle> {
    await this.init();
    const rowRef = await this.resolveRowRef(collection, row);
    const fields = await this.refreshFields(rowRef);
    return new RowHandle(this, rowRef, fields);
  }

  async query(
    collection: keyof Schema & string,
    options: DbQueryOptions,
  ): Promise<RowHandle[]> {
    await this.init();
    const parentRefs = this.normalizeParents(options.in);
    if (parentRefs.length === 0) {
      throw new Error("query requires at least one parent in scope");
    }

    const collectionSpec = this.getCollectionSpec(collection);
    const selectedIndex = this.pickIndex(collectionSpec, options);
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));

    const parentResults = await Promise.all(parentRefs.map(async (parent) => {
      const params = new URLSearchParams();
      params.set("collection", collection);
      params.set("order", options.order ?? "asc");
      params.set("limit", String(limit));

      if (selectedIndex) {
        params.set("index", selectedIndex.name);
        if (selectedIndex.encodedValue !== null) {
          params.set("value", selectedIndex.encodedValue);
        }
      } else if (options.where) {
        params.set("where", JSON.stringify(options.where));
      }

      return this.requestRoomJson<DbQueryResponse>(
        `${stripTrailingSlash(parent.workerUrl)}/db-query?${params.toString()}`,
        "GET",
      );
    }));

    const deduped = new Map<string, DbQueryRow>();
    for (const result of parentResults) {
      for (const row of result.rows) {
        const key = `${row.owner}:${row.rowId}`;
        if (!deduped.has(key)) {
          deduped.set(key, row);
        }
      }
    }

    const rows = Array.from(deduped.values()).slice(0, limit);
    const hydrated = await Promise.all(rows.map(async (row) => {
      const rowRef: DbRowRef = {
        id: row.rowId,
        collection,
        owner: row.owner,
        workerUrl: stripTrailingSlash(row.workerUrl),
      };

      try {
        const fullFields = await this.refreshFields(rowRef);
        return new RowHandle(this, rowRef, fullFields);
      } catch {
        return new RowHandle(this, rowRef, row.fields);
      }
    }));

    return hydrated;
  }

  async addParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    await this.init();
    this.assertParentAllowed(child.collection, parent.collection);

    const childFields = await this.refreshFields(child);
    const childSchema = this.getCollectionSpec(child.collection);

    await this.requestRoomJson(`${stripTrailingSlash(parent.workerUrl)}/register-child`, "POST", {
      childRowId: child.id,
      childOwner: child.owner,
      childWorkerUrl: child.workerUrl,
      collection: child.collection,
      fields: childFields,
      schema: {
        indexes: childSchema.indexes,
      },
    });

    await this.requestRoomJson(`${stripTrailingSlash(child.workerUrl)}/link-parent`, "POST", {
      parentWorkerUrl: parent.workerUrl,
    });
  }

  async removeParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    await this.init();

    await this.requestRoomJson(`${stripTrailingSlash(parent.workerUrl)}/unregister-child`, "POST", {
      childRowId: child.id,
      childOwner: child.owner,
      collection: child.collection,
    });

    await this.requestRoomJson(`${stripTrailingSlash(child.workerUrl)}/unlink-parent`, "POST", {
      parentWorkerUrl: parent.workerUrl,
    });
  }

  async listParents(child: DbRowRef): Promise<DbRowRef[]> {
    await this.init();
    const room = await this.rooms.getRoom(child.workerUrl);

    return room.parentRooms.map((workerUrl) => {
      const parsed = parseRoomRefFromWorkerUrl(workerUrl);
      return {
        id: parsed.id,
        owner: parsed.owner,
        workerUrl: stripTrailingSlash(workerUrl),
        collection: "unknown",
      } satisfies DbRowRef;
    });
  }

  async addMember(row: DbRowRef, username: string, role: MemberRole): Promise<void> {
    await this.init();
    await this.requestRoomJson(`${stripTrailingSlash(row.workerUrl)}/members-add`, "POST", {
      username,
      role,
    });
  }

  async removeMember(row: DbRowRef, username: string): Promise<void> {
    await this.init();
    await this.requestRoomJson(`${stripTrailingSlash(row.workerUrl)}/members-remove`, "POST", {
      username,
    });
  }

  async listDirectMembers(row: DbRowRef): Promise<Array<{ username: string; role: MemberRole }>> {
    await this.init();
    const payload = await this.requestRoomJson<ListMembersResponse>(
      `${stripTrailingSlash(row.workerUrl)}/members-direct`,
      "GET",
    );
    return payload.members;
  }

  async listEffectiveMembers(row: DbRowRef): Promise<DbMemberInfo[]> {
    await this.init();
    const payload = await this.requestRoomJson<EffectiveMembersResponse>(
      `${stripTrailingSlash(row.workerUrl)}/members-effective`,
      "GET",
    );
    return payload.members;
  }

  async refreshFields(row: DbRowRef): Promise<Record<string, JsonValue>> {
    await this.init();
    const response = await this.requestRoomJson<GetFieldsResponse>(
      `${stripTrailingSlash(row.workerUrl)}/fields`,
      "GET",
    );
    return response.fields;
  }

  private async requestRoomJson<T>(
    url: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    await this.init();
    const user = await this.rooms.whoAmI();
    const workersExec = this.resolveWorkersExec();

    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        "x-puter-username": user.username,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    const response = workersExec
      ? await workersExec(url, init)
      : await this.fetchFn(url, init);

    if (!response.ok) {
      const maybeApiError = await response
        .json()
        .catch((): unknown => ({ code: "BAD_REQUEST", message: response.statusText }));
      throw new PuterFedError(toApiError(maybeApiError), response.status);
    }

    return (await response.json()) as T;
  }

  private resolveWorkersExec(): PuterWorkersExec | null {
    const exec = (this.puter?.workers as { exec?: unknown } | undefined)?.exec;
    if (typeof exec === "function") {
      return exec as PuterWorkersExec;
    }

    const globalPuter = (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    const globalExec = (globalPuter?.workers as { exec?: unknown } | undefined)?.exec;
    return typeof globalExec === "function" ? (globalExec as PuterWorkersExec) : null;
  }

  private getCollectionSpec(collection: string): DbCollectionSpec {
    const collectionSpec = this.schema[collection];
    if (!collectionSpec) {
      throw new Error(`Unknown collection: ${collection}`);
    }

    return collectionSpec;
  }

  private applyDefaults(
    collectionSpec: DbCollectionSpec,
    fields: Record<string, JsonValue>,
  ): Record<string, JsonValue> {
    const next: Record<string, JsonValue> = { ...fields };

    for (const [fieldName, fieldSpec] of Object.entries(collectionSpec.fields)) {
      if (next[fieldName] !== undefined) {
        continue;
      }

      if (fieldSpec.default !== undefined) {
        next[fieldName] = fieldSpec.default;
      }
    }

    return next;
  }

  private normalizeParents(input: DbRowRef | DbRowRef[] | undefined): DbRowRef[] {
    if (!input) {
      return [];
    }

    return Array.isArray(input) ? input : [input];
  }

  private assertInsertParents(
    collection: string,
    collectionSpec: DbCollectionSpec,
    parents: DbRowRef[],
  ): void {
    const allowedParents = collectionSpec.in ?? [];
    if (allowedParents.length === 0 && parents.length > 0) {
      throw new Error(`Collection ${collection} does not allow parent links`);
    }

    if (allowedParents.length > 0 && parents.length === 0) {
      throw new Error(`Collection ${collection} requires an in parent`);
    }

    for (const parent of parents) {
      if (!allowedParents.includes(parent.collection)) {
        throw new Error(`Collection ${collection} cannot be in ${parent.collection}`);
      }
    }
  }

  private assertParentAllowed(childCollection: string, parentCollection: string): void {
    const childSpec = this.getCollectionSpec(childCollection);
    const allowedParents = childSpec.in ?? [];
    if (!allowedParents.includes(parentCollection)) {
      throw new Error(`Collection ${childCollection} cannot be in ${parentCollection}`);
    }
  }

  private pickIndex(
    collectionSpec: DbCollectionSpec,
    options: DbQueryOptions,
  ): { name: string; encodedValue: string | null } | null {
    if (options.index) {
      const explicit = collectionSpec.indexes?.[options.index];
      if (!explicit) {
        throw new Error(`Unknown index: ${options.index}`);
      }

      if (options.value === undefined || options.value === null) {
        return { name: options.index, encodedValue: null };
      }

      return {
        name: options.index,
        encodedValue: encodeFieldValue(options.value),
      };
    }

    if (!options.where || !collectionSpec.indexes) {
      return null;
    }

    const whereEntries = Object.entries(options.where);
    if (whereEntries.length !== 1) {
      return null;
    }

    const [whereField, whereValue] = whereEntries[0];
    for (const [indexName, indexSpec] of Object.entries(collectionSpec.indexes)) {
      if (indexSpec.fields.length === 1 && indexSpec.fields[0] === whereField) {
        return {
          name: indexName,
          encodedValue: encodeFieldValue(whereValue),
        };
      }
    }

    return null;
  }

  private async resolveRowRef(collection: string, row: string | DbRowRef): Promise<DbRowRef> {
    if (typeof row !== "string") {
      return {
        ...row,
        collection,
      };
    }

    const user = await this.rooms.whoAmI();
    return {
      id: row,
      collection,
      owner: user.username,
      workerUrl: resolveWorkerUrl(user.username, row, this.workerBaseUrl),
    };
  }
}
