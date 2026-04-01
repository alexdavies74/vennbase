import {
  CURRENT_USER,
  type Vennbase,
  collection,
  defineSchema,
  field,
  type AnyRowHandle,
  type DbAnonymousProjection,
  type RowHandle,
  type RowRef,
} from "@vennbase/core";

import { useAcceptInviteFromUrl, useShareLink, useQuery, useRow } from "./index";

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
      createdAt: field.number().key(),
    },
  }),
  recentDogs: collection({
    in: ["user"],
    fields: {
      dogRef: field.ref("dogs").key(),
      openedAt: field.number().key(),
    },
  }),
});

type TestSchema = typeof schema;
type DogHandle = RowHandle<TestSchema, "dogs">;
type TagHandle = RowHandle<TestSchema, "tags">;

type DogResult = ReturnType<typeof useRow<TestSchema, "dogs">>;
type TagRows = ReturnType<typeof useQuery<TestSchema, "tags">>["rows"];
type InviteResult = ReturnType<typeof useAcceptInviteFromUrl<TestSchema>>["data"];

declare const dogResult: DogResult;
declare const tagRows: TagRows;
declare const dogHandle: DogHandle;
declare const anyRowHandle: AnyRowHandle<TestSchema>;
declare const tagRef: RowRef<"tags">;
declare const anyClient: Vennbase<TestSchema>;
declare const inviteResult: InviteResult;

const maybeAnyRowHandle: AnyRowHandle<TestSchema> | undefined = dogResult.data;
const maybeDogHandle: DogHandle | undefined = dogResult.data;
const fallbackTagRows: TagHandle[] = tagRows ?? [];
const maybeTagHandle: TagHandle | undefined = tagRows?.[0];
const projectedTags = useQuery(anyClient, "tags", {
  in: dogHandle,
  select: "anonymous",
  orderBy: "createdAt",
});
const recentDogs = useQuery(anyClient, "recentDogs", {
  in: CURRENT_USER,
  orderBy: "openedAt",
});
const projectedTag: DbAnonymousProjection<TestSchema, "tags"> | undefined = projectedTags.rows?.[0];
const recentDog: RowHandle<TestSchema, "recentDogs"> | undefined = recentDogs.rows?.[0];
const dogName: string = dogHandle.fields.name;
void maybeAnyRowHandle;
void maybeDogHandle;
void maybeTagHandle;
void fallbackTagRows;
void projectedTag;
void recentDog;
void dogName;

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

// @ts-expect-error anonymous projections do not expose row refs
void projectedTag?.ref;

// @ts-expect-error anonymous projections are not row inputs
void useRow(anyClient, projectedTag);

// @ts-expect-error anonymous projections are not row handles
void useShareLink(anyClient, projectedTag, { role: "editor" });

if (dogResult.data) {
  // @ts-expect-error parentless rows should not accept parent refs
  void dogResult.data.in.add(tagRef);
}

if (anyRowHandle.collection === "dogs") {
  const narrowedDogHandle: DogHandle = anyRowHandle;
  const narrowedDogName: string = narrowedDogHandle.fields.name;
  void narrowedDogName;
}

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
  void useShareLink(anyClient, firstTag, { role: "editor" });
  void useShareLink(anyClient, firstTag, { role: "contributor" });
  void useShareLink(anyClient, firstTag, { role: "submitter" });
}

export {};
