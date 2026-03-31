import {
  type Vennbase,
  collection,
  defineSchema,
  field,
  type AnyRowHandle,
  type DbQueryProjectedRow,
  type RowHandle,
  type RowRef,
} from "@vennbase/core";

import { useShareLink, useQuery, useRow } from "./index";

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
});

type TestSchema = typeof schema;
type DogHandle = RowHandle<TestSchema, "dogs">;
type TagHandle = RowHandle<TestSchema, "tags">;

type DogResult = ReturnType<typeof useRow<TestSchema, "dogs">>;
type TagRows = ReturnType<typeof useQuery<TestSchema, "tags">>["rows"];

declare const dogResult: DogResult;
declare const tagRows: TagRows;
declare const dogHandle: DogHandle;
declare const anyRowHandle: AnyRowHandle<TestSchema>;
declare const tagRef: RowRef<"tags">;
declare const anyClient: Vennbase<TestSchema>;

const maybeAnyRowHandle: AnyRowHandle<TestSchema> | undefined = dogResult.data;
const maybeDogHandle: DogHandle | undefined = dogResult.data;
const fallbackTagRows: TagHandle[] = tagRows ?? [];
const maybeTagHandle: TagHandle | undefined = tagRows?.[0];
const projectedTags = useQuery(anyClient, "tags", {
  in: dogHandle,
  select: "keys",
  orderBy: "createdAt",
});
const projectedTag: DbQueryProjectedRow<TestSchema, "tags"> | undefined = projectedTags.rows?.[0];
const dogName: string = dogHandle.fields.name;
void maybeAnyRowHandle;
void maybeDogHandle;
void maybeTagHandle;
void fallbackTagRows;
void projectedTag;
void dogName;

// @ts-expect-error key-query projections are anonymous and do not expose row refs
void projectedTag?.ref;

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
