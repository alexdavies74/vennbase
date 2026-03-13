import { PutBase } from "./putbase";
import {
  collection,
  defineSchema,
  field,
  index,
  type DbRowRef,
} from "./schema";

const typeTestSchema = defineSchema({
  projects: collection({
    fields: {
      name: field.string(),
    },
  }),
  teams: collection({
    fields: {
      name: field.string(),
    },
  }),
  tasks: collection({
    in: ["projects"],
    fields: {
      title: field.string(),
      status: field.string().default("todo"),
      points: field.number().optional(),
    },
    indexes: {
      byStatus: index("status"),
      byTitleStatus: index(["title", "status"]),
    },
  }),
});

declare const projectRef: DbRowRef<"projects">;
declare const teamRef: DbRowRef<"teams">;

const db = new PutBase({
  schema: typeTestSchema,
  identityProvider: async () => ({ username: "typecheck" }),
});

void db.put("tasks", { title: "Ship v2" });
void db.put("tasks", { title: "Ship v2", points: 3 }, { in: projectRef });

// @ts-expect-error tasks.title is required on insert
void db.put("tasks", {});

// @ts-expect-error tasks can only be created under projects
void db.put("tasks", { title: "Ship v2" }, { in: teamRef });

void db.query("tasks", { in: projectRef, where: { status: "done" } });
void db.query("tasks", { in: projectRef, index: "byStatus", value: "done" });
void db.query("tasks", { in: projectRef, index: "byTitleStatus", value: ["Ship v2", "done"] });

// @ts-expect-error invalid where field
void db.query("tasks", { in: projectRef, where: { missing: "nope" } });

// @ts-expect-error invalid index name
void db.query("tasks", { in: projectRef, index: "byMissing", value: "done" });

// @ts-expect-error composite indexes require tuple values
void db.query("tasks", { in: projectRef, index: "byTitleStatus", value: "done" });

// @ts-expect-error tasks can only be queried under projects
void db.query("tasks", { in: teamRef });

void db.put("projects", { name: "Website" }).then((project) => {
  const name: string = project.fields.name;
  void name;
});

void db.put("tasks", { title: "Ship v2" }, { in: projectRef }).then((task) => {
  const title: string = task.fields.title;
  const status: string = task.fields.status;
  const maybePoints: number | undefined = task.fields.points;
  void title;
  void status;
  void maybePoints;
  void task.in.add(projectRef);
  void task.in.list().then((parents) => {
    const firstParent = parents[0];
    if (firstParent) {
      const name: "projects" = firstParent.collection;
      void name;
    }
  });

  // @ts-expect-error tasks can only link to projects
  void task.in.add(teamRef);
});

void db.getRowByUrl("https://workers.example/rooms/room_1").then((row) => {
  const collection: "projects" | "teams" | "tasks" = row.collection;
  void collection;

  if (row.collection === "projects" || row.collection === "teams") {
    const name: string = row.fields.name;
    void name;
  }

  if (row.collection === "tasks") {
    const title: string = row.fields.title;
    void title;
  }
});

export {};
