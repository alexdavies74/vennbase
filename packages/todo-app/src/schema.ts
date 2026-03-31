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
      boardRef: field.ref("boards").key(),
      openedAt: field.number().key(),
    },
  }),
  cards: collection({
    in: ["boards"],
    fields: {
      text: field.string(),
      done: field.boolean(),
      createdAt: field.number().key(),
    },
  }),
});

export type Schema = typeof schema;
