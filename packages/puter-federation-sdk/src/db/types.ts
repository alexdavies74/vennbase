import type { JsonValue } from "../types";

export type FieldType = "string" | "number" | "boolean" | "date" | "json";

export interface DbFieldSpec {
  type: FieldType;
  optional?: boolean;
  default?: JsonValue;
}

export interface DbIndexSpec {
  fields: string[];
}

export interface DbCollectionSpec {
  in?: string[];
  fields: Record<string, DbFieldSpec>;
  indexes?: Record<string, DbIndexSpec>;
}

export type DbSchema = Record<string, DbCollectionSpec>;

export type MemberRole = "admin" | "writer" | "reader";

export interface DbRowRef {
  id: string;
  collection: string;
  owner: string;
  workerUrl: string;
}

export interface DbRow<TFields extends Record<string, JsonValue> = Record<string, JsonValue>>
  extends DbRowRef {
  fields: TFields;
}

export interface DbPutOptions {
  in?: DbRowRef | DbRowRef[];
  name?: string;
}

export interface DbQueryOptions {
  in: DbRowRef | DbRowRef[];
  where?: Record<string, JsonValue>;
  index?: string;
  value?: JsonValue;
  order?: "asc" | "desc";
  limit?: number;
}

export interface DbQueryWatchCallbacks<TRow> {
  onChange(rows: TRow[]): void;
  onError?(error: unknown): void;
}

export interface DbQueryWatchHandle {
  disconnect(): void;
  refresh(): Promise<void>;
}

export interface DbMemberInfo {
  username: string;
  role: MemberRole;
  via: "direct" | DbRowRef;
}
