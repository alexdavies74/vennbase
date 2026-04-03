import {
  Vennbase,
  RowHandle,
  collection,
  defineSchema,
  field,
} from "@vennbase/core";

export const woofSchema = defineSchema({
  dogs: collection({
    fields: {
      name: field.string(),
    },
  }),
  dogHistory: collection({
    in: ["user"],
    fields: {
      dogRef: field.ref("dogs").indexKey(),
      status: field.string().indexKey(),
    },
  }),
  tags: collection({
    in: ["dogs"],
    fields: {
      label: field.string(),
      createdBy: field.string(),
      createdAt: field.number().indexKey(),
    },
  }),
});

export type WoofSchema = typeof woofSchema;
export type WoofDb = Vennbase<WoofSchema>;
export type DogRowHandle = RowHandle<WoofSchema, "dogs">;
export type DogHistoryRowHandle = RowHandle<WoofSchema, "dogHistory">;
export type TagRowHandle = RowHandle<WoofSchema, "tags">;
