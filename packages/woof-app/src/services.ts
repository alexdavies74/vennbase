import { CoveDB } from "@covedb/core";

import { woofSchema, type WoofDb } from "./schema";
import { WoofService } from "./service";

export const db: WoofDb = new CoveDB({
  appBaseUrl: window.location.origin,
  schema: woofSchema,
});

export const service = new WoofService(db);
