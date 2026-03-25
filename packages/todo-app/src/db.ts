import { CoveDB } from "@covedb/core";
import { schema } from "./schema";

export const db = new CoveDB({ schema, appBaseUrl: window.location.origin });
