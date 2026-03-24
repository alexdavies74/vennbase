import {
  collection,
  defineSchema,
  field,
  index,
  type AnyRowHandle,
  type RowHandle,
  type RowRef,
} from "@putbase/core";

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
      createdAt: field.number(),
    },
    indexes: {
      byCreatedAt: index("createdAt"),
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
declare const anyClient: any;

const maybeAnyRowHandle: AnyRowHandle<TestSchema> | undefined = dogResult.data;
const maybeDogHandle: DogHandle | undefined = dogResult.data;
const maybeTagHandle: TagHandle | undefined = tagRows[0];
const dogName: string = dogHandle.fields.name;
void maybeAnyRowHandle;
void maybeDogHandle;
void maybeTagHandle;
void dogName;

if (dogResult.data) {
  // @ts-expect-error parentless rows should not accept parent refs
  void dogResult.data.in.add(tagRef);
}

if (anyRowHandle.collection === "dogs") {
  const narrowedDogHandle: DogHandle = anyRowHandle;
  const narrowedDogName: string = narrowedDogHandle.fields.name;
  void narrowedDogName;
}

if (tagRows[0]) {
  void tagRows[0].in.add({
    id: "dog_1",
    collection: "dogs",
    baseUrl: "https://worker.example",
  });
  const createdAt: number = tagRows[0].fields.createdAt;
  void createdAt;

  // @ts-expect-error tags can only be parented by dogs
  void tagRows[0].in.add(tagRef);

  void useRow(anyClient, tagRows[0]);
  void useShareLink(anyClient, tagRows[0]);
}

export {};
