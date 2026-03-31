import { encodeCompositeFieldValues, encodeFieldValue } from "./key-encoding";

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

type BuiltInUserScope = typeof BUILTIN_USER_SCOPE;
type ReservedCollectionName = BuiltInUserScope;

export interface DbFieldBuilder<
  TValue extends DbFieldValue = DbFieldValue,
  TType extends FieldType = FieldType,
  TOptional extends boolean = false,
  THasDefault extends boolean = false,
> {
  readonly kind: "field";
  readonly type: TType;
  readonly isOptional: TOptional;
  readonly hasDefault: THasDefault;
  readonly defaultValue: THasDefault extends true ? TValue : undefined;
  readonly refCollections?: readonly string[];
  optional(): DbFieldBuilder<TValue, TType, true, THasDefault>;
  default(value: TValue): DbFieldBuilder<TValue, TType, TOptional, true>;
  readonly __value?: TValue;
}

type AnyDbFieldBuilder = DbFieldBuilder<DbFieldValue, FieldType, boolean, boolean>;

function createFieldBuilder<
  TValue extends DbFieldValue,
  TType extends FieldType,
  TOptional extends boolean,
  THasDefault extends boolean,
>(config: {
  type: TType;
  isOptional: TOptional;
  hasDefault: THasDefault;
  defaultValue?: TValue;
  refCollections?: readonly string[];
}): DbFieldBuilder<TValue, TType, TOptional, THasDefault> {
  return {
    kind: "field",
    type: config.type,
    isOptional: config.isOptional,
    hasDefault: config.hasDefault,
    defaultValue: config.defaultValue as THasDefault extends true ? TValue : undefined,
    refCollections: config.refCollections,
    optional() {
      return createFieldBuilder<TValue, TType, true, THasDefault>({
        ...config,
        isOptional: true,
      });
    },
    default(value: TValue) {
      return createFieldBuilder<TValue, TType, TOptional, true>({
        ...config,
        hasDefault: true,
        defaultValue: value,
      });
    },
  };
}

export const field = {
  string() {
    return createFieldBuilder<string, "string", false, false>({
      type: "string",
      isOptional: false,
      hasDefault: false,
    });
  },
  number() {
    return createFieldBuilder<number, "number", false, false>({
      type: "number",
      isOptional: false,
      hasDefault: false,
    });
  },
  boolean() {
    return createFieldBuilder<boolean, "boolean", false, false>({
      type: "boolean",
      isOptional: false,
      hasDefault: false,
    });
  },
  date() {
    return createFieldBuilder<string, "date", false, false>({
      type: "date",
      isOptional: false,
      hasDefault: false,
    });
  },
  ref<const TCollections extends string | readonly string[]>(collections: TCollections) {
    type TCollectionName =
      TCollections extends string ? TCollections
        : TCollections extends readonly string[] ? TCollections[number]
          : never;

    const refCollections = Array.isArray(collections) ? [...collections] : [collections];
    return createFieldBuilder<RowRef<TCollectionName>, "ref", false, false>({
      type: "ref",
      isOptional: false,
      hasDefault: false,
      refCollections,
    });
  },
} as const;

type NormalizeIndexFields<TFields extends string | readonly string[]> =
  TFields extends string ? readonly [TFields] : TFields;

export interface DbIndexDefinition<TFields extends readonly string[] = readonly string[]> {
  readonly fields: TFields;
}

export function index<const TFields extends string | readonly string[]>(
  fields: TFields,
): DbIndexDefinition<NormalizeIndexFields<TFields>> {
  return {
    fields: (Array.isArray(fields) ? [...fields] : [fields]) as unknown as NormalizeIndexFields<TFields>,
  };
}

export type DbCollectionDefinition<
  TFields extends Record<string, AnyDbFieldBuilder> = Record<string, AnyDbFieldBuilder>,
  TParents extends readonly string[] | undefined = undefined,
  TIndexes extends Record<string, DbIndexDefinition> | undefined = undefined,
> = {
  readonly fields: TFields;
} & (
  TParents extends readonly string[] ? { readonly in: TParents } : { readonly in?: undefined }
) & (
  TIndexes extends Record<string, DbIndexDefinition> ? { readonly indexes: TIndexes } : { readonly indexes?: undefined }
);

type AnyDbCollectionDefinition = DbCollectionDefinition<
  Record<string, AnyDbFieldBuilder>,
  readonly string[] | undefined,
  Record<string, DbIndexDefinition> | undefined
>;

export type DbSchema = Record<string, AnyDbCollectionDefinition>;

type AssertNoReservedCollectionNames<TSchema extends DbSchema> =
  Extract<keyof TSchema & string, ReservedCollectionName> extends never
    ? unknown
    : { __vennbase_reserved_collection_name_user__: never };

export function collection<
  const TFields extends Record<string, AnyDbFieldBuilder>,
  const TIndexes extends Record<string, DbIndexDefinition<readonly (keyof TFields & string)[]>> | undefined = undefined,
>(definition: {
  fields: TFields;
  indexes?: TIndexes;
}): DbCollectionDefinition<TFields, undefined, TIndexes>;

export function collection<
  const TFields extends Record<string, AnyDbFieldBuilder>,
  const TParents extends readonly string[],
  const TIndexes extends Record<string, DbIndexDefinition<readonly (keyof TFields & string)[]>> | undefined = undefined,
>(definition: {
  fields: TFields;
  in: TParents;
  indexes?: TIndexes;
}): DbCollectionDefinition<TFields, TParents, TIndexes>;

export function collection<
  const TFields extends Record<string, AnyDbFieldBuilder>,
  const TParents extends readonly string[] | undefined = undefined,
  const TIndexes extends Record<string, DbIndexDefinition<readonly (keyof TFields & string)[]>> | undefined = undefined,
>(definition: {
  fields: TFields;
  in?: TParents;
  indexes?: TIndexes;
}): DbCollectionDefinition<TFields, TParents, TIndexes> {
  return definition as unknown as DbCollectionDefinition<TFields, TParents, TIndexes>;
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
  TField extends DbFieldBuilder<infer TValue, FieldType, boolean, boolean> ? TValue : never;

type FieldIsOptional<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer _TValue, FieldType, infer TOptional, boolean> ? TOptional : never;

type FieldHasDefault<TField extends AnyDbFieldBuilder> =
  TField extends DbFieldBuilder<infer _TValue, FieldType, boolean, infer THasDefault> ? THasDefault : never;

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

type IsUserOnlyCollection<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = [DeclaredParentCollections<Schema, TCollection>] extends [readonly [BuiltInUserScope]] ? true : false;

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
  [TCollection] extends [never] ? never : RowInput<TCollection> | RowInput<TCollection>[];

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
  IsUserOnlyCollection<Schema, TCollection> extends true
    ? {
      in?: ParentInput<AllowedParentCollections<Schema, TCollection>>;
      name?: string;
    }
    : HasDeclaredParents<Schema, TCollection> extends true
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
  IsUserOnlyCollection<Schema, TCollection> extends true
    ? [options?: DbCreateOptions<Schema, TCollection>]
    : HasDeclaredParents<Schema, TCollection> extends true
      ? [options: DbCreateOptions<Schema, TCollection>]
      : [options?: DbCreateOptions<Schema, TCollection>];

type QueryFieldValue<TField extends AnyDbFieldBuilder> = Exclude<InferFieldValue<TField>, undefined>;

export type QueryWhere<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Partial<{
  [K in keyof FieldDefinitions<Schema, TCollection>]: QueryFieldValue<FieldDefinitions<Schema, TCollection>[K]>;
}>;

export type CollectionIndexes<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = NonNullable<Schema[TCollection]["indexes"]>;

type IndexValueForFields<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TFields extends readonly string[],
> = TFields extends readonly [infer TField extends keyof FieldDefinitions<Schema, TCollection> & string]
  ? QueryFieldValue<FieldDefinitions<Schema, TCollection>[TField]>
  : {
    [K in keyof TFields]:
      TFields[K] extends keyof FieldDefinitions<Schema, TCollection> & string
        ? QueryFieldValue<FieldDefinitions<Schema, TCollection>[TFields[K]]>
        : never;
  };

export type IndexValue<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TIndex extends keyof CollectionIndexes<Schema, TCollection> & string,
> = IndexValueForFields<Schema, TCollection, CollectionIndexes<Schema, TCollection>[TIndex]["fields"]>;

type QueryBaseOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = (
  IsUserOnlyCollection<Schema, TCollection> extends true
    ? {
      in?: ParentInput<AllowedParentCollections<Schema, TCollection>>;
    }
    : {
      in: ParentInput<AllowedParentCollections<Schema, TCollection>>;
    }
) & {
  where?: QueryWhere<Schema, TCollection>;
  order?: "asc" | "desc";
  limit?: number;
};

type QueryIndexOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> =
  [keyof CollectionIndexes<Schema, TCollection> & string] extends [never] ? never
    : {
      [TIndex in keyof CollectionIndexes<Schema, TCollection> & string]:
        QueryBaseOptions<Schema, TCollection> & {
          index: TIndex;
          value?: IndexValue<Schema, TCollection, TIndex>;
        };
    }[keyof CollectionIndexes<Schema, TCollection> & string];

export type DbQueryOptions<
  Schema extends DbSchema = DbSchema,
  TCollection extends CollectionName<Schema> = CollectionName<Schema>,
> =
  | (QueryBaseOptions<Schema, TCollection> & {
    index?: undefined;
    value?: undefined;
  })
  | QueryIndexOptions<Schema, TCollection>;

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

export function hasImplicitUserScope(collectionSpec: AnyDbCollectionDefinition): boolean {
  const parents = collectionSpec.in ?? [];
  return parents.length === 1 && parents[0] === BUILTIN_USER_SCOPE;
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

function encodeQueryIndexValue(
  indexSpec: DbIndexDefinition,
  value: DbFieldValue | readonly DbFieldValue[],
): string {
  if (indexSpec.fields.length > 1) {
    if (!Array.isArray(value)) {
      throw new Error(`Index ${indexSpec.fields.join(",")} requires a tuple value`);
    }
    return encodeCompositeFieldValues(Array.from(value));
  }

  return encodeFieldValue(value as DbFieldValue);
}

export function pickIndex<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  collectionSpec: Schema[TCollection],
  options: DbQueryOptions<Schema, TCollection>,
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
      encodedValue: encodeQueryIndexValue(
        explicit,
        options.value as DbFieldValue | readonly DbFieldValue[],
      ),
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
        encodedValue: encodeFieldValue(whereValue as DbFieldValue),
      };
    }
  }

  return null;
}
