import { PutBase } from "@putbase/core";

import { woofSchema, type WoofDb } from "./schema";
import { WoofService } from "./service";

export const pb: WoofDb = new PutBase({
  appBaseUrl: window.location.origin,
  schema: woofSchema,
});

export const service = new WoofService(pb);
