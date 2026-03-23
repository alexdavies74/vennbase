import {
  PutBase,
  RowHandle,
  collection,
  defineSchema,
  field,
  index,
  type RowFields,
} from "@putbase/core";

export const woofSchema = defineSchema({
  dogs: collection({
    fields: {
      name: field.string(),
    },
  }),
  dogHistory: collection({
    in: ["user"],
    fields: {
      dogRef: field.ref("dogs"),
      status: field.string(),
    },
    indexes: {
      byDogRef: index("dogRef"),
      byStatus: index("status"),
    },
  }),
  tags: collection({
    in: ["dogs"],
    fields: {
      label: field.string(),
      createdBy: field.string(),
      createdAt: field.number(),
    },
    indexes: {
      byCreatedAt: index("createdAt"),
    },
  }),
});

export type WoofSchema = typeof woofSchema;
export type WoofDb = PutBase<WoofSchema>;
export type DogFields = RowFields<WoofSchema, "dogs">;
export type DogHistoryFields = RowFields<WoofSchema, "dogHistory">;
export type TagFields = RowFields<WoofSchema, "tags">;
export type DogRowHandle = RowHandle<"dogs", DogFields, never, WoofSchema>;
export type DogHistoryRowHandle = RowHandle<"dogHistory", DogHistoryFields, "user", WoofSchema>;
export type TagRowHandle = RowHandle<"tags", TagFields, "dogs", WoofSchema>;
