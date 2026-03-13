import {
  PutBase,
  RowHandle,
  collection,
  defineSchema,
  field,
  index,
  type RowFields,
} from "puter-federation-sdk";

export const woofSchema = defineSchema({
  dogs: collection({
    fields: {
      name: field.string(),
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
export type TagFields = RowFields<WoofSchema, "tags">;
export type DogRowHandle = RowHandle<"dogs", DogFields, never, WoofSchema>;
export type TagRowHandle = RowHandle<"tags", TagFields, "dogs", WoofSchema>;
