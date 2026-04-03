import { collection, defineSchema, field } from "@vennbase/core";

export const schema = defineSchema({
  boards: collection({
    fields: {
      title: field.string(),
    },
  }),
  recentBoards: collection({
    in: ["user"],
    fields: {
      boardRef: field.ref("boards").indexKey(),
      openedAt: field.number().indexKey(),
    },
  }),
  cards: collection({
    in: ["boards"],
    fields: {
      text: field.string(),
      done: field.boolean(),
      createdAt: field.number().indexKey(),
    },
  }),
});

export type Schema = typeof schema;
