import { Vennbase } from "@vennbase/core";

import { AppointmentService } from "./service";
import { schema, type AppointmentDb } from "./schema";

export const db: AppointmentDb = new Vennbase({
  appBaseUrl: window.location.origin,
  schema,
});

export const service = new AppointmentService(db);
