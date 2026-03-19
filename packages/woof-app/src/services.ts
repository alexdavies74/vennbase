import * as Y from "yjs";
import { PutBase } from "@putbase/core";

import { woofSchema, type WoofDb } from "./schema";
import { WoofService } from "./service";

export const db: WoofDb = new PutBase({
  appBaseUrl: window.location.origin,
  schema: woofSchema,
});

const doc = new Y.Doc();

export const service = new WoofService(db, doc);
