import type { RowHandle } from "./row-handle.js";

export interface RowRef<TCollection extends string = string> {
  id: string;
  collection: TCollection;
  baseUrl: string;
}

export type RowTarget<TCollection extends string = string> =
  | RowRef<TCollection>
  | { ref: RowRef<TCollection> };

export type RowInput<TCollection extends string = string> = RowTarget<TCollection>;

export type DbFieldValue = string | number | boolean | RowRef;

export type FieldType = "string" | "number" | "boolean" | "date" | "ref";

export type DbRowFields = { [key: string]: DbFieldValue | undefined };

export const BUILTIN_USER_SCOPE = "user" as const;
export interface CurrentUser {
  readonly __vennbase: "CURRENT_USER";
}

export const CURRENT_USER = Object.freeze({
  __vennbase: "CURRENT_USER",
}) as CurrentUser;

type BuiltInUserScope = typeof BUILTIN_USER_SCOPE;
type ReservedCollectionName = BuiltInUserScope;

export function isCurrentUser(value: unknown): value is CurrentUser {
  return typeof value === "object"
    && value !== null
    && "__vennbase" in value
    && value.__vennbase === "CURRENT_USER";
}

export function isRowRef<TCollection extends string = string>(value: unknown): value is RowRef<TCollection> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.collection === "string"
    && typeof record.baseUrl === "string";
}

export function toRowRef<TCollection extends string>(
  row: RowTarget<TCollection>,
): RowRef<TCollection> {
  return isRowRef(row) ? row : row.ref;
}

export interface DbFieldBuilder<
  TValue extends DbFieldValue = DbFieldValue,
  TType extends FieldType = FieldType,
  TOptional extends boolean = false,
  THasDefault extends boolean = false,
  TIsIndexKey extends boolean = false,
> {
  readonly kind: "field";
  readonly type: TType;
  readonly isOptional: TOptional;
  readonly hasDefault: THasDefault;
  readonly isIndexKey: TIsIndexKey;
  readonly defaultValue: THasDefault extends true ? TValue : undefined;
  readonly refCollections?: readonly string[];
  optional(): DbFieldBuilder<TValue, TType, true, THasDefault, TIsIndexKey>;
  default(value: TValue): DbFieldBuilder<TValue, TType, TOptional, true, TIsIndexKey>;
  indexKey(): DbFieldBuilder<TValue, TType, TOptional, THasDefault, true>;
  readonly __value?: TValue;
}

type AnyDbFieldBuilder = DbFieldBuilder<DbFieldValue, FieldType, boolean, boolean, boolean>;

function createFieldBuilder<
  TValue extends DbFieldValue,
  TType extends FieldType,
  TOptional extends boolean,
  THasDefault extends boolean,
  TIsIndexKey extends boolean,
>(config: {
  type: TType;
  isOptional: TOptional;
  hasDefault: THasDefault;
  isIndexKey: TIsIndexKey;
  defaultValue?: TValue;
  refCollections?: readonly string[];
}): DbFieldBuilder<TValue, TType, TOptional, THasDefault, TIsIndexKey> {
  return {
    kind: "field",
    type: config.type,
    isOptional: config.isOptional,
    hasDefault: config.hasDefault,
    isIndexKey: config.isIndexKey,
    defaultValue: config.defaultValue as THasDefault extends true ? TValue : undefined,
    refCollections: config.refCollections,
    optional() {
      return createFieldBuilder<TValue, TType, true, THasDefault, TIsIndexKey>({
        ...config,
        isOptional: true,
      });
    },
    default(value: TValue) {
      return createFieldBuilder<TValue, TType, TOptional, true, TIsIndexKey>({
        ...config,
        hasDefault: true,
        defaultValue: value,
      });
    },
    indexKey() {
      return createFieldBuilder<TValue, TType, TOptional, THasDefault, true>({
        ...config,
        isIndexKey: true,
      });
    },
  };
}

export const field = {
  string() {
    return createFieldBuilder<string, "string", false, false, false>({
      type: "string",
      isOptional: false,
      hasDefault: false,
      isIndexKey: false,
    });
  },
  number() {
    return createFieldBuilder<number, "number", false, false, false>({
      type: "number",
      isOptional: false,
      hasDefault: false,
      isIndexKey: false,
    });
  },
  boolean() {
    return createFieldBuilder<boolean, "boolean", false, false, false>({
      type: "boolean",
      isOptional: false,
      hasDefault: false,
      isIndexKey: false,
    });
  },
  date() {
    return createFieldBuilder<string, "date", false, false, false>({
      type: "date",
      isOptional: false,
      hasDefault: false,
      isIndexKey: false,
    });
  },
  ref<const TCollections extends string | readonly string[]>(collections: TCollections) {
    type TCollectionName =
      TCollections extends string ? TCollections
        : TCollections extends readonly string[] ? TCollections[number]
          : never;

    const refCollections = Array.isArray(collections) ? [...collections] : [collections];
    return createFieldBuilder<RowRef<TCollectionName>, "ref", false, false, false>({
      type: "ref",
      isOptional: false,
      hasDefault: false,
      isIndexKey: false,
      refCollections,
    });
  },
} as const;

export type DbCollectionDefinition<
  TFields extends Record<string, AnyDbFieldBuilder> = Record<string, AnyDbFieldBuilder>,
  TParents extends readonly string[] | undefined = undefined,
> = {
  readonly fields: TFields;
} & (
  TParents extends readonly string[] ? { readonly in: TParents } : { readonly in?: undefined }
);

type AnyDbCollectionDefinition = DbCollectionDefinition<
  Record<string, AnyDbFieldBuilder>,
  readonly string[] | undefined
>;

export type DbSchema = Record<string, AnyDbCollectionDefinition>;

type AssertNoReservedCollectionNames<TSchema extends DbSchema> =
  Extract<keyof TSchema & string, ReservedCollectionName> extends never
    ? unknown
    : { __vennbase_reserved_collection_name_user__: never };

export function collection<
  const TFields extends Record<string, AnyDbFieldBuilder>,
>(definition: {
  fields: TFields;
}): DbCollectionDefinition<TFields, undefined>;

export function collection<
  const TFields extends Record<string, AnyDbFieldBuilder>,
  const TParents extends readonly string[],
>(definition: {
  fields: TFields;
  in: TParents;
}): DbCollectionDefinition<TFields, TParents>;

export function collection<
  const TFields extends Record<string, AnyDbFieldBuilder>,
  const TParents extends readonly string[] | undefined = undefined,
>(definition: {
  fields: TFields;
  in?: TParents;
}): DbCollectionDefinition<TFields, TParents> {
  return definition as unknown as DbCollectionDefinition<TFields, TParents>;
}

export function defineSchema<const TSchema extends DbSchema>(
  schema: TSchema & AssertNoReservedCollectionNames<TSchema>,
): TSchema {
  if (BUILTIN_USER_SCOPE in schema) {
    throw new Error(`Collection name "${BUILTIN_USER_SCOPE}" is reserved`);
  }
  return schema;
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type InferFieldValue<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer TValue, FieldType, boolean, boolean, boolean> ? TValue : never;

type FieldIsOptional<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer _TValue, FieldType, infer TOptional, boolean, boolean> ? TOptional : never;

type FieldHasDefault<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer _TValue, FieldType, boolean, infer THasDefault, boolean> ? THasDefault : never;

type FieldIsIndexKey<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer _TValue, FieldType, boolean, boolean, infer TIsIndexKey> ? TIsIndexKey : never;

type FieldDefinitions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Schema[TCollection]["fields"];

type RequiredInsertKeys<TFields extends Record<string, AnyDbFieldBuilder>> = {
  [K in keyof TFields]-?:
    FieldIsOptional<TFields[K]> extends true ? never
      : FieldHasDefault<TFields[K]> extends true ? never
        : K;
}[keyof TFields];

type OptionalInsertKeys<TFields extends Record<string, AnyDbFieldBuilder>> =
  Exclude<keyof TFields, RequiredInsertKeys<TFields>>;

type RequiredRowKeys<TFields extends Record<string, AnyDbFieldBuilder>> = {
  [K in keyof TFields]-?:
    FieldHasDefault<TFields[K]> extends true ? K
      : FieldIsOptional<TFields[K]> extends true ? never
        : K;
}[keyof TFields];

type OptionalRowKeys<TFields extends Record<string, AnyDbFieldBuilder>> =
  Exclude<keyof TFields, RequiredRowKeys<TFields>>;

type DeclaredParentCollections<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = NonNullable<Schema[TCollection]["in"]>;

type HasDeclaredParents<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = [DeclaredParentCollections<Schema, TCollection>] extends [never] ? false : true;

export type CollectionName<Schema extends DbSchema> = keyof Schema & string;

export type RowFields<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Simplify<
  { [K in RequiredRowKeys<FieldDefinitions<Schema, TCollection>>]: InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> } &
  { [K in OptionalRowKeys<FieldDefinitions<Schema, TCollection>>]?: InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> }
>;

export type InsertFields<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Simplify<
  { [K in RequiredInsertKeys<FieldDefinitions<Schema, TCollection>>]: InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> } &
  { [K in OptionalInsertKeys<FieldDefinitions<Schema, TCollection>>]?: InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> }
>;

export type AllowedParentCollections<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = NonNullable<Schema[TCollection]["in"]> extends readonly string[]
  ? NonNullable<Schema[TCollection]["in"]>[number]
  : never;

export type AnyRowRef<Schema extends DbSchema> = {
  [TCollection in CollectionName<Schema>]: RowRef<TCollection>;
}[CollectionName<Schema>];

type ParentInput<TCollection extends string> =
  [TCollection] extends [never]
    ? never
    : Array<RowInput<TCollection> | (BuiltInUserScope extends TCollection ? CurrentUser : never)>
      | RowInput<TCollection>
      | (BuiltInUserScope extends TCollection ? CurrentUser : never);

export type AllowedParentRef<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = RowRef<AllowedParentCollections<Schema, TCollection>>;

export interface DbRow<
  TCollection extends string = string,
  TFields extends DbRowFields = DbRowFields,
> extends RowRef<TCollection> {
  fields: TFields;
}

export type AnyRow<Schema extends DbSchema> = {
  [TCollection in CollectionName<Schema>]: DbRow<TCollection, RowFields<Schema, TCollection>>;
}[CollectionName<Schema>];

export type DbCreateOptions<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> =
  HasDeclaredParents<Schema, TCollection> extends true
    ? {
      in: ParentInput<AllowedParentCollections<Schema, TCollection>>;
      name?: string;
    }
    : {
      in?: never;
      name?: string;
    };

export type DbCreateArgs<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> =
  HasDeclaredParents<Schema, TCollection> extends true
    ? [options: DbCreateOptions<Schema, TCollection>]
    : [options?: DbCreateOptions<Schema, TCollection>];

type QueryFieldValue<TField extends AnyDbFieldBuilder> = Exclude<InferFieldValue<TField>, undefined>;

export type IndexKeyFieldNames<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = {
  [K in keyof FieldDefinitions<Schema, TCollection>]-?:
    FieldIsIndexKey<FieldDefinitions<Schema, TCollection>[K]> extends true ? K : never;
}[keyof FieldDefinitions<Schema, TCollection>] & string;

type HasIndexKeyFields<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = [IndexKeyFieldNames<Schema, TCollection>] extends [never] ? false : true;

type QueryOptionDiagnostic<TMessage extends string> = {
  readonly [K in TMessage]: never;
};

type NoIndexKeyWhereDiagnostic<TCollection extends string> = QueryOptionDiagnostic<
  `Collection "${TCollection}" has no index-key fields; where is unavailable. Mark a field with .indexKey() to enable filtering.`
>;

type NoIndexKeyOrderByDiagnostic<TCollection extends string> = QueryOptionDiagnostic<
  `Collection "${TCollection}" has no index-key fields; orderBy is unavailable. Mark a field with .indexKey() to enable ordering.`
>;

type QueryOrderBy<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = HasIndexKeyFields<Schema, TCollection> extends true
  ? IndexKeyFieldNames<Schema, TCollection>
  : keyof NoIndexKeyOrderByDiagnostic<TCollection> & string;

export type QueryWhere<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = HasIndexKeyFields<Schema, TCollection> extends true
  ? Partial<{
    [K in IndexKeyFieldNames<Schema, TCollection>]: QueryFieldValue<FieldDefinitions<Schema, TCollection>[K]>;
  }>
  : NoIndexKeyWhereDiagnostic<TCollection>;

type QueryBaseOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = HasDeclaredParents<Schema, TCollection> extends true ? {
  in: ParentInput<AllowedParentCollections<Schema, TCollection>>;
  where?: QueryWhere<Schema, TCollection>;
  orderBy?: QueryOrderBy<Schema, TCollection>;
  order?: "asc" | "desc";
  limit?: number;
} : never;

export type DbQuerySelect = "full" | "indexKeys";

export type IndexKeyRowFields<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Simplify<
  { [K in Extract<IndexKeyFieldNames<Schema, TCollection>, RequiredRowKeys<FieldDefinitions<Schema, TCollection>>>]:
      InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> } &
  { [K in Extract<IndexKeyFieldNames<Schema, TCollection>, OptionalRowKeys<FieldDefinitions<Schema, TCollection>>>]?:
      InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> }
>;

export interface DbIndexKeyProjection<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> {
  kind: "index-key-projection";
  id: string;
  collection: TCollection;
  fields: IndexKeyRowFields<Schema, TCollection>;
}

export function isIndexKeyProjection<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
>(value: unknown): value is DbIndexKeyProjection<Schema, TCollection> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.kind === "index-key-projection"
    && typeof record.id === "string"
    && typeof record.collection === "string"
    && typeof record.fields === "object"
    && record.fields !== null;
}

export type DbQueryRow<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
  TSelect extends DbQuerySelect = "full",
> = TSelect extends "indexKeys"
  ? DbIndexKeyProjection<Schema, TCollection>
  : RowHandle<Schema, TCollection>;

export type DbQueryRows<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
  TSelect extends DbQuerySelect = "full",
> = Array<DbQueryRow<Schema, TCollection, TSelect>>;

export type InferDbQuerySelect<TOptions> = TOptions extends { select: "indexKeys" }
  ? "indexKeys"
  : "full";

export type DbQueryOptions<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
  TSelect extends DbQuerySelect = "full",
> = QueryBaseOptions<Schema, TCollection> & (
  TSelect extends "indexKeys"
    ? { select: "indexKeys" }
    : { select?: "full" | undefined }
);

export type DbFullQueryOptions<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> = DbQueryOptions<Schema, TCollection, "full">;

export type DbIndexKeyQueryOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = DbQueryOptions<Schema, TCollection, "indexKeys">;

export interface DbQueryWatchCallbacks<TRow> {
  onChange(rows: TRow[]): void;
  onError?(error: unknown): void;
}

export interface DbQueryWatchHandle {
  disconnect(): void;
  refresh(): Promise<void>;
}

export type MemberRole =
  | "index-viewer"
  | "index-submitter"
  | "index-editor"
  | "content-viewer"
  | "content-submitter"
  | "content-editor"
  | "all-viewer"
  | "all-submitter"
  | "all-editor";

export interface DbMemberInfo<Schema extends DbSchema = DbSchema> {
  username: string;
  roles: MemberRole[];
  via: "direct" | AnyRowRef<Schema>;
}

export function getCollectionSpec<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(schema: Schema, collection: TCollection): Schema[TCollection] {
  const spec = schema[collection];
  if (!spec) {
    throw new Error(`Unknown collection: ${collection}`);
  }
  return spec;
}

export function collectionAllowsCurrentUser(collectionSpec: AnyDbCollectionDefinition): boolean {
  const parents = collectionSpec.in ?? [];
  return parents.includes(BUILTIN_USER_SCOPE);
}

export function resolveCollectionName<Schema extends DbSchema>(
  schema: Schema,
  collection: string | null | undefined,
): CollectionName<Schema> {
  if (!collection) {
    throw new Error("Row collection is missing");
  }

  if (!(collection in schema)) {
    throw new Error(`Unknown collection: ${collection}`);
  }

  return collection as CollectionName<Schema>;
}

export function applyDefaults<
  TCollectionSpec extends AnyDbCollectionDefinition,
  TFields extends DbRowFields,
>(
  collectionSpec: TCollectionSpec,
  fields: TFields,
): TFields {
  const next: DbRowFields = { ...fields };

  for (const [fieldName, fieldSpec] of Object.entries(collectionSpec.fields)) {
    if (next[fieldName] !== undefined) {
      continue;
    }

    if (fieldSpec.hasDefault && fieldSpec.defaultValue !== undefined) {
      next[fieldName] = fieldSpec.defaultValue;
    }
  }

  return next as TFields;
}

export function assertCreateParents(
  collection: string,
  collectionSpec: AnyDbCollectionDefinition,
  parents: Array<Pick<RowRef, "collection">>,
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

export function getCollectionIndexKeyFieldNames(collectionSpec: AnyDbCollectionDefinition): string[] {
  return Object.entries(collectionSpec.fields)
    .filter(([, fieldSpec]) => fieldSpec.isIndexKey)
    .map(([fieldName]) => fieldName);
}

export function pickIndexKeyFieldValues(
  collectionSpec: AnyDbCollectionDefinition,
  fields: Record<string, unknown>,
): Record<string, DbFieldValue> {
  const next: Record<string, DbFieldValue> = {};
  for (const fieldName of getCollectionIndexKeyFieldNames(collectionSpec)) {
    const value = fields[fieldName];
    if (value !== undefined) {
      next[fieldName] = value as DbFieldValue;
    }
  }
  return next;
}

export function assertParentAllowed(
  schema: DbSchema,
  childCollection: string,
  parentCollection: string,
): void {
  const childSpec = getCollectionSpec(schema, childCollection);
  const allowedParents = childSpec.in ?? [];
  if (!allowedParents.includes(parentCollection)) {
    throw new Error(`Collection ${childCollection} cannot be in ${parentCollection}`);
  }
}

function describeExpectedFieldType(fieldType: FieldType): string {
  switch (fieldType) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "date":
      return "an ISO date string";
    case "ref":
      return "a row ref";
  }
}

function isRowRefValue(value: unknown, allowedCollections?: readonly string[]): value is RowRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.collection !== "string"
    || typeof record.baseUrl !== "string"
  ) {
    return false;
  }

  return !allowedCollections || allowedCollections.includes(record.collection);
}

function isFieldValueType(value: unknown, fieldSpec: AnyDbFieldBuilder): value is DbFieldValue {
  switch (fieldSpec.type) {
    case "string":
    case "date":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "ref":
      return isRowRefValue(value, fieldSpec.refCollections);
  }
}

export function assertValidFieldValues(
  collection: string,
  collectionSpec: AnyDbCollectionDefinition,
  fields: Record<string, unknown>,
): void {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Error(`Fields for ${collection} must be an object`);
  }

  for (const [fieldName, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    const fieldSpec = collectionSpec.fields[fieldName];
    if (!fieldSpec) {
      throw new Error(`Unknown field ${collection}.${fieldName}`);
    }

    if (!isFieldValueType(value, fieldSpec)) {
      throw new Error(
        `Field ${collection}.${fieldName} must be ${describeExpectedFieldType(fieldSpec.type)}`,
      );
    }
  }
}
