export interface RowRef<TCollection extends string = string> {
  id: string;
  collection: TCollection;
  baseUrl: string;
}

export type RowInput<TCollection extends string = string> =
  | RowRef<TCollection>
  | { ref: RowRef<TCollection> };

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

export interface DbFieldBuilder<
  TValue extends DbFieldValue = DbFieldValue,
  TType extends FieldType = FieldType,
  TOptional extends boolean = false,
  THasDefault extends boolean = false,
  TIsKey extends boolean = false,
> {
  readonly kind: "field";
  readonly type: TType;
  readonly isOptional: TOptional;
  readonly hasDefault: THasDefault;
  readonly isKey: TIsKey;
  readonly defaultValue: THasDefault extends true ? TValue : undefined;
  readonly refCollections?: readonly string[];
  optional(): DbFieldBuilder<TValue, TType, true, THasDefault, TIsKey>;
  default(value: TValue): DbFieldBuilder<TValue, TType, TOptional, true, TIsKey>;
  key(): DbFieldBuilder<TValue, TType, TOptional, THasDefault, true>;
  readonly __value?: TValue;
}

type AnyDbFieldBuilder = DbFieldBuilder<DbFieldValue, FieldType, boolean, boolean, boolean>;

function createFieldBuilder<
  TValue extends DbFieldValue,
  TType extends FieldType,
  TOptional extends boolean,
  THasDefault extends boolean,
  TIsKey extends boolean,
>(config: {
  type: TType;
  isOptional: TOptional;
  hasDefault: THasDefault;
  isKey: TIsKey;
  defaultValue?: TValue;
  refCollections?: readonly string[];
}): DbFieldBuilder<TValue, TType, TOptional, THasDefault, TIsKey> {
  return {
    kind: "field",
    type: config.type,
    isOptional: config.isOptional,
    hasDefault: config.hasDefault,
    isKey: config.isKey,
    defaultValue: config.defaultValue as THasDefault extends true ? TValue : undefined,
    refCollections: config.refCollections,
    optional() {
      return createFieldBuilder<TValue, TType, true, THasDefault, TIsKey>({
        ...config,
        isOptional: true,
      });
    },
    default(value: TValue) {
      return createFieldBuilder<TValue, TType, TOptional, true, TIsKey>({
        ...config,
        hasDefault: true,
        defaultValue: value,
      });
    },
    key() {
      return createFieldBuilder<TValue, TType, TOptional, THasDefault, true>({
        ...config,
        isKey: true,
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
      isKey: false,
    });
  },
  number() {
    return createFieldBuilder<number, "number", false, false, false>({
      type: "number",
      isOptional: false,
      hasDefault: false,
      isKey: false,
    });
  },
  boolean() {
    return createFieldBuilder<boolean, "boolean", false, false, false>({
      type: "boolean",
      isOptional: false,
      hasDefault: false,
      isKey: false,
    });
  },
  date() {
    return createFieldBuilder<string, "date", false, false, false>({
      type: "date",
      isOptional: false,
      hasDefault: false,
      isKey: false,
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
      isKey: false,
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

type FieldIsKey<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer _TValue, FieldType, boolean, boolean, infer TIsKey> ? TIsKey : never;

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

export type KeyFieldNames<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = {
  [K in keyof FieldDefinitions<Schema, TCollection>]-?:
    FieldIsKey<FieldDefinitions<Schema, TCollection>[K]> extends true ? K : never;
}[keyof FieldDefinitions<Schema, TCollection>] & string;

export type QueryWhere<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Partial<{
  [K in KeyFieldNames<Schema, TCollection>]: QueryFieldValue<FieldDefinitions<Schema, TCollection>[K]>;
}>;

type QueryBaseOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = HasDeclaredParents<Schema, TCollection> extends true ? {
  in: ParentInput<AllowedParentCollections<Schema, TCollection>>;
  where?: QueryWhere<Schema, TCollection>;
  orderBy?: KeyFieldNames<Schema, TCollection>;
  order?: "asc" | "desc";
  limit?: number;
} : never;

export type DbQuerySelect = "full" | "anonymous";

export type KeyRowFields<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Simplify<
  { [K in Extract<KeyFieldNames<Schema, TCollection>, RequiredRowKeys<FieldDefinitions<Schema, TCollection>>>]:
      InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> } &
  { [K in Extract<KeyFieldNames<Schema, TCollection>, OptionalRowKeys<FieldDefinitions<Schema, TCollection>>>]?:
      InferFieldValue<FieldDefinitions<Schema, TCollection>[K]> }
>;

export interface DbAnonymousProjection<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> {
  kind: "anonymous-projection";
  id: string;
  collection: TCollection;
  keyFields: KeyRowFields<Schema, TCollection>;
}

export type DbFullQueryOptions<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> = QueryBaseOptions<Schema, TCollection> & {
  select?: "full" | undefined;
};

export type DbAnonymousQueryOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = QueryBaseOptions<Schema, TCollection> & {
  select: "anonymous";
};

export type DbQueryOptions<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> = DbFullQueryOptions<Schema, TCollection> | DbAnonymousQueryOptions<Schema, TCollection>;

export interface DbQueryWatchCallbacks<TRow> {
  onChange(rows: TRow[]): void;
  onError?(error: unknown): void;
}

export interface DbQueryWatchHandle {
  disconnect(): void;
  refresh(): Promise<void>;
}

export type MemberRole = "editor" | "contributor" | "viewer" | "submitter";

export interface DbMemberInfo<Schema extends DbSchema = DbSchema> {
  username: string;
  role: MemberRole;
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
  parents: RowRef[],
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

export function getCollectionKeyFieldNames(collectionSpec: AnyDbCollectionDefinition): string[] {
  return Object.entries(collectionSpec.fields)
    .filter(([, fieldSpec]) => fieldSpec.isKey)
    .map(([fieldName]) => fieldName);
}

export function pickKeyFieldValues(
  collectionSpec: AnyDbCollectionDefinition,
  fields: Record<string, unknown>,
): Record<string, DbFieldValue> {
  const next: Record<string, DbFieldValue> = {};
  for (const fieldName of getCollectionKeyFieldNames(collectionSpec)) {
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
