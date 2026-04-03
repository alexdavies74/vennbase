import { AuthManager } from "./auth.js";
import { resolveBackend } from "./backend.js";
import { Identity } from "./identity.js";
import { listSavedRows, type SavedRowEntry } from "./saved-rows.js";
import type { DbFieldValue, DbMemberInfo, MemberRole, RowInput, RowRef } from "./schema.js";
import { normalizeRowRef, rowRefKey } from "./row-reference.js";
import { Transport } from "./transport.js";
import type { AuthSession, BackendClient, JsonValue, RowSnapshot, VennbaseUser } from "./types.js";
import type { VennbaseOptions } from "./vennbase.js";

interface InspectorGetFieldsResponse {
  fields: Record<string, JsonValue>;
  collection: string | null;
}

interface InspectorQueryResponseRow {
  rowId: string;
  collection: string;
  fields: Record<string, JsonValue>;
  owner?: string;
  baseUrl?: string;
}

interface InspectorQueryResponse {
  rows: InspectorQueryResponseRow[];
}

export interface VennbaseInspectorOptions extends Pick<VennbaseOptions, "backend" | "fetchFn" | "identityProvider"> {}

export interface InspectorQueryOptions {
  collection?: string;
  orderBy?: string;
  order?: "asc" | "desc";
  limit?: number;
  where?: Record<string, DbFieldValue>;
}

export interface InspectorIndexKeyQueryOptions extends InspectorQueryOptions {
  select: "indexKeys";
}

export interface InspectorFullQueryOptions extends InspectorQueryOptions {
  select?: "full";
}

export interface InspectorFullQueryRow {
  id: string;
  collection: string;
  owner: string;
  ref: RowRef;
  fields: Record<string, JsonValue>;
}

export interface InspectorIndexKeyQueryRow {
  kind: "index-key-projection";
  id: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

export interface InspectorCrawlNode {
  ref: RowRef;
  meta: RowSnapshot | null;
  fields: Record<string, JsonValue> | null;
  childRefs: RowRef[];
}

export interface InspectorCrawlEdge {
  from: RowRef | null;
  to: RowRef;
  type: "seed" | "parent" | "child";
}

export interface InspectorCrawlError {
  ref: RowRef;
  stage: "meta" | "fields" | "children";
  message: string;
}

export interface InspectorCrawlResult {
  nodes: InspectorCrawlNode[];
  edges: InspectorCrawlEdge[];
  errors: InspectorCrawlError[];
}

export interface InspectorCrawlOptions {
  childLimit?: number;
  maxRows?: number;
}

export class VennbaseInspector {
  private readonly identity: Identity;
  private readonly auth: AuthManager;
  private readonly transport: Transport;

  constructor(private readonly options: VennbaseInspectorOptions = {}) {
    this.identity = new Identity(options);
    this.auth = new AuthManager(resolveBackend(options.backend), () => this.identity.whoAmI().then((user) => user.username));
    this.transport = new Transport(options, this.auth);
  }

  async getSession(): Promise<AuthSession> {
    let session = await this.identity.getSession();
    if (!session.signedIn && !this.options.backend && resolveBackend()) {
      this.identity.clear();
      session = await this.identity.getSession();
    }
    return session;
  }

  async signIn(): Promise<VennbaseUser> {
    this.identity.clear();
    return this.identity.signIn();
  }

  async whoAmI(): Promise<VennbaseUser> {
    return this.identity.whoAmI();
  }

  async listSavedRows(): Promise<SavedRowEntry[]> {
    await this.identity.whoAmI();
    return listSavedRows(resolveBackend(this.options.backend));
  }

  async getRowMeta(row: RowInput): Promise<RowSnapshot> {
    await this.identity.whoAmI();
    return this.transport.row(normalizeRowRef(row)).request<RowSnapshot>("row/get", {});
  }

  async getRowFields(row: RowInput): Promise<InspectorGetFieldsResponse> {
    await this.identity.whoAmI();
    return this.transport.row(normalizeRowRef(row)).request<InspectorGetFieldsResponse>("fields/get", {});
  }

  async getDirectMembers(row: RowInput): Promise<Array<{ username: string; role: MemberRole }>> {
    await this.identity.whoAmI();
    const payload = await this.transport.row(normalizeRowRef(row)).request<{ members: Array<{ username: string; role: MemberRole }> }>("members/direct", {});
    return payload.members;
  }

  async getEffectiveMembers(row: RowInput): Promise<Array<DbMemberInfo>> {
    await this.identity.whoAmI();
    const payload = await this.transport.row(normalizeRowRef(row)).request<{ members: DbMemberInfo[] }>("members/effective", {});
    return payload.members;
  }

  async queryChildren(parent: RowInput, options: InspectorIndexKeyQueryOptions): Promise<InspectorIndexKeyQueryRow[]>;
  async queryChildren(parent: RowInput, options?: InspectorFullQueryOptions): Promise<InspectorFullQueryRow[]>;
  async queryChildren(
    parent: RowInput,
    options: InspectorQueryOptions & { select?: "full" | "indexKeys" } = {},
  ): Promise<InspectorFullQueryRow[] | InspectorIndexKeyQueryRow[]> {
    await this.identity.whoAmI();
    const parentRef = normalizeRowRef(parent);
    const response = await this.transport.row(parentRef).request<InspectorQueryResponse>("db/query", {
      collection: options.collection,
      select: options.select ?? "full",
      orderBy: options.orderBy,
      order: options.order,
      limit: options.limit,
      where: options.where,
    });

    if (options.select === "indexKeys") {
      return response.rows.map((row) => ({
        kind: "index-key-projection",
        id: row.rowId,
        collection: row.collection,
        fields: row.fields,
      }));
    }

    return response.rows
      .filter((row): row is InspectorQueryResponseRow & { owner: string; baseUrl: string } =>
        typeof row.owner === "string" && typeof row.baseUrl === "string",
      )
      .map((row) => ({
        id: row.rowId,
        collection: row.collection,
        owner: row.owner,
        ref: {
          id: row.rowId,
          collection: row.collection,
          baseUrl: row.baseUrl,
        },
        fields: row.fields,
      }));
  }

  async crawl(seedRows: RowInput[], options: InspectorCrawlOptions = {}): Promise<InspectorCrawlResult> {
    await this.identity.whoAmI();

    const maxRows = Math.max(1, options.maxRows ?? 200);
    const childLimit = Math.max(1, options.childLimit ?? 200);
    const queue = seedRows.map((row) => normalizeRowRef(row));
    const queued = new Set(queue.map((row) => rowRefKey(row)));
    const visited = new Set<string>();
    const nodes = new Map<string, InspectorCrawlNode>();
    const edges: InspectorCrawlEdge[] = queue.map((row) => ({ from: null, to: row, type: "seed" }));
    const errors: InspectorCrawlError[] = [];

    while (queue.length > 0 && visited.size < maxRows) {
      const next = queue.shift();
      if (!next) {
        break;
      }

      const key = rowRefKey(next);
      queued.delete(key);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      let meta: RowSnapshot | null = null;
      let fields: Record<string, JsonValue> | null = null;
      let canonicalRef = next;

      try {
        meta = await this.getRowMeta(next);
        canonicalRef = {
          id: meta.id,
          collection: meta.collection ?? next.collection,
          baseUrl: meta.baseUrl,
        };
      } catch (error) {
        errors.push({
          ref: next,
          stage: "meta",
          message: error instanceof Error ? error.message : "Failed to load row metadata.",
        });
      }

      try {
        const response = await this.getRowFields(canonicalRef);
        fields = response.fields;
        if (response.collection) {
          canonicalRef = {
            ...canonicalRef,
            collection: response.collection,
          };
        }
      } catch (error) {
        errors.push({
          ref: canonicalRef,
          stage: "fields",
          message: error instanceof Error ? error.message : "Failed to load row fields.",
        });
      }

      const childRefs: RowRef[] = [];

      if (meta) {
        for (const parentRef of meta.parentRefs) {
          edges.push({
            from: canonicalRef,
            to: parentRef,
            type: "parent",
          });
          const parentKey = rowRefKey(parentRef);
          if (!visited.has(parentKey) && !queued.has(parentKey)) {
            queue.push(parentRef);
            queued.add(parentKey);
          }
        }
      }

      try {
        const children = await this.queryChildren(canonicalRef, { limit: childLimit });
        for (const child of children) {
          childRefs.push(child.ref);
          edges.push({
            from: canonicalRef,
            to: child.ref,
            type: "child",
          });
          const childKey = rowRefKey(child.ref);
          if (!visited.has(childKey) && !queued.has(childKey)) {
            queue.push(child.ref);
            queued.add(childKey);
          }
        }
      } catch (error) {
        errors.push({
          ref: canonicalRef,
          stage: "children",
          message: error instanceof Error ? error.message : "Failed to query children.",
        });
      }

      nodes.set(rowRefKey(canonicalRef), {
        ref: canonicalRef,
        meta,
        fields,
        childRefs,
      });
    }

    return {
      nodes: Array.from(nodes.values()),
      edges,
      errors,
    };
  }
}
