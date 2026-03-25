import {
  CoveDB,
  RowHandle,
  collection,
  defineSchema,
  field,
  index,
} from "@covedb/core";

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
export type WoofDb = CoveDB<WoofSchema>;
export type DogRowHandle = RowHandle<WoofSchema, "dogs">;
export type DogHistoryRowHandle = RowHandle<WoofSchema, "dogHistory">;
export type TagRowHandle = RowHandle<WoofSchema, "tags">;
