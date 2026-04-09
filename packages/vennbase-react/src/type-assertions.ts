import {
  CURRENT_USER,
  type Vennbase,
  collection,
  defineSchema,
  field,
  type AnyRowHandle,
  type DbIndexKeyProjection,
  type DbQueryOptions,
  type DbQueryRow,
  type DbQuerySelect,
  type RowHandle,
  type RowRef,
} from "@vennbase/core";

import { useAcceptInviteFromUrl, useCurrentUser, useSavedRow, useShareLink, useQuery, useRow } from "./index.js";

const schema = defineSchema({
  dogs: collection({
    fields: {
      name: field.string(),
    },
  }),
  tags: collection({
    in: ["dogs"],
    fields: {
      label: field.string(),
      createdAt: field.number().indexKey(),
    },
  }),
  recentDogs: collection({
    in: ["user"],
    fields: {
      dogRef: field.ref("dogs").indexKey(),
      openedAt: field.number().indexKey(),
    },
  }),
});

type TestSchema = typeof schema;
type DogHandle = RowHandle<TestSchema, "dogs">;
type TagHandle = RowHandle<TestSchema, "tags">;

type DogResult = ReturnType<typeof useRow<TestSchema, "dogs">>;
type TagRows = ReturnType<typeof useQuery<TestSchema, "tags">>["rows"];
type SavedDogResult = ReturnType<typeof useSavedRow<TestSchema, "dogs">>;
type CurrentUserResult = ReturnType<typeof useCurrentUser<TestSchema>>;
type InviteResult = ReturnType<typeof useAcceptInviteFromUrl<TestSchema>>["data"];

declare const dogResult: DogResult;
declare const tagRows: TagRows;
declare const savedDogResult: SavedDogResult;
declare const dogHandle: DogHandle;
declare const dogRef: RowRef<"dogs">;
declare const anyRowHandle: AnyRowHandle<TestSchema>;
declare const tagRef: RowRef<"tags">;
declare const anyClient: Vennbase<TestSchema>;
declare const currentUserResult: CurrentUserResult;
declare const inviteResult: InviteResult;

const maybeAnyRowHandle: AnyRowHandle<TestSchema> | undefined = dogResult.data;
const maybeDogHandle: DogHandle | undefined = dogResult.data;
const maybeDogHandleFromAlias: DogHandle | undefined = dogResult.row;
const maybeDogHandleFromRef: DogHandle | undefined = useRow(anyClient, dogRef).row;
const fallbackTagRows: TagHandle[] = tagRows ?? [];
const maybeTagHandle: TagHandle | undefined = tagRows?.[0];
const maybeSavedDogHandle: DogHandle | null | undefined = savedDogResult.row;
const maybeCurrentUser: { username: string } | undefined = currentUserResult.user;
const maybeDogNameFromRef: string | undefined = useRow(anyClient, dogRef).row?.fields.name;
const savedDog = useSavedRow(anyClient, {
  key: "current-dog",
  collection: "dogs",
});
const savedDogSummary = useSavedRow(anyClient, {
  key: "current-dog-summary",
  collection: "dogs",
  loadSavedRow: (row) => ({
    dog: row,
    id: row.id,
  }),
  getRow: (result) => result.dog,
});
const projectedTags = useQuery(anyClient, "tags", {
  in: dogHandle,
  select: "indexKeys",
  orderBy: "createdAt",
});
const projectedTagOptions: DbQueryOptions<TestSchema, "tags", "indexKeys"> = {
  in: dogHandle,
  select: "indexKeys",
  orderBy: "createdAt",
};
const recentDogOptions: DbQueryOptions<TestSchema, "recentDogs"> = {
  in: CURRENT_USER,
  orderBy: "openedAt",
};
const projectedTagsFromOptions = useQuery(anyClient, "tags", projectedTagOptions);
const recentDogs = useQuery(anyClient, "recentDogs", {
  in: CURRENT_USER,
  orderBy: "openedAt",
});
const recentDogsFromOptions = useQuery(anyClient, "recentDogs", recentDogOptions);
const projectedTag: DbIndexKeyProjection<TestSchema, "tags"> | undefined = projectedTags.rows?.[0];
const projectedTagFromOptions: DbQueryRow<TestSchema, "tags", "indexKeys"> | undefined = projectedTagsFromOptions.rows?.[0];
const recentDog: RowHandle<TestSchema, "recentDogs"> | undefined = recentDogs.rows?.[0];
const recentDogFromOptions: DbQueryRow<TestSchema, "recentDogs"> | undefined = recentDogsFromOptions.rows?.[0];
const dogName: string = dogHandle.fields.name;
const projectedCreatedAt: number | undefined = projectedTag?.fields.createdAt;
const maybeSavedDogName: string | undefined = savedDog.row?.fields.name;
const maybeSavedDogSummaryName: string | undefined = savedDogSummary.row?.dog.fields.name;

function useTypedQuery<
  TCollection extends keyof TestSchema & string,
  TSelect extends DbQuerySelect = "full",
>(collection: TCollection, options: DbQueryOptions<TestSchema, TCollection, TSelect>) {
  return useQuery(anyClient, collection, options);
}

const genericProjectedTag: DbQueryRow<TestSchema, "tags", "indexKeys"> | undefined =
  useTypedQuery("tags", projectedTagOptions).rows?.[0];
const genericRecentDog: DbQueryRow<TestSchema, "recentDogs"> | undefined =
  useTypedQuery("recentDogs", recentDogOptions).rows?.[0];

void maybeAnyRowHandle;
void maybeDogHandle;
void maybeDogHandleFromAlias;
void maybeDogHandleFromRef;
void maybeTagHandle;
void maybeSavedDogHandle;
void maybeCurrentUser;
void fallbackTagRows;
void projectedTag;
void projectedTagFromOptions;
void recentDog;
void recentDogFromOptions;
void genericProjectedTag;
void genericRecentDog;
void dogName;
void projectedCreatedAt;
void savedDog;
void savedDogSummary;
void maybeDogNameFromRef;
void maybeSavedDogName;
void maybeSavedDogSummaryName;

// @ts-expect-error queries always require an explicit in option
void useQuery(anyClient, "recentDogs", {
  orderBy: "openedAt",
});

// @ts-expect-error parentless collections cannot be queried
void useQuery(anyClient, "dogs", {});

if (inviteResult?.kind === "opened") {
  const openedRow: AnyRowHandle<TestSchema> = inviteResult.row;
  void openedRow;
}

// @ts-expect-error index-key projections do not expose row refs
void projectedTag?.ref;

// @ts-expect-error index-key projections expose fields, not indexKeyFields
void projectedTag?.indexKeyFields;

// @ts-expect-error index-key projections are not row inputs
void useRow(anyClient, projectedTag);

// @ts-expect-error index-key projections are not row handles
void useShareLink(anyClient, projectedTag, "all-editor");

if (dogResult.data) {
  // @ts-expect-error parentless rows should not accept parent refs
  void dogResult.data.in.add(tagRef);
}

if (anyRowHandle.collection === "dogs") {
  const narrowedDogHandle: DogHandle = anyRowHandle;
  const narrowedDogName: string = narrowedDogHandle.fields.name;
  void narrowedDogName;
}

useSavedRow(anyClient, {
  key: "current-dog-via-ref",
  collection: "dogs",
  getRow: (row) => row.ref,
});

useSavedRow(anyClient, {
  key: "bad-dog-transform",
  collection: "dogs",
  // @ts-expect-error dogs should narrow before custom transforms
  loadSavedRow: (row) => row.fields.label,
});

useSavedRow<TestSchema, "dogs", { row: DogHandle }>(anyClient, {
  key: "bad-dog-row",
  collection: "dogs",
  loadSavedRow: (row) => ({ row }),
  // @ts-expect-error getRow must stay within the selected collection
  getRow: () => tagRef,
});

const firstTag = tagRows?.[0];

if (firstTag) {
  void firstTag.in.add({
    id: "dog_1",
    collection: "dogs",
    baseUrl: "https://worker.example",
  });
  const createdAt: number = firstTag.fields.createdAt;
  void createdAt;

  // @ts-expect-error tags can only be parented by dogs
  void firstTag.in.add(tagRef);

  void useRow(anyClient, firstTag);
  void useShareLink(anyClient, firstTag, "all-editor");
  void useShareLink(anyClient, firstTag, "content-submitter");
  void useShareLink(anyClient, firstTag, "index-submitter");
  void useShareLink(anyClient, firstTag, "all-editor", { enabled: true });

  // @ts-expect-error role is now positional
  void useShareLink(anyClient, firstTag, { role: "all-editor" });
}

export {};
