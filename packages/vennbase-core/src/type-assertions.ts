import { Vennbase } from "./vennbase";
import {
  CURRENT_USER,
  collection,
  defineSchema,
  field,
  type DbQueryProjectedRow,
  type RowRef,
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
      status: field.string().key().default("todo"),
      points: field.number().optional(),
    },
  }),
  gameRecords: collection({
    in: ["user"],
    fields: {
      gameRef: field.ref("projects").key(),
      role: field.string().key(),
    },
  }),
  mixedRecords: collection({
    in: ["user", "projects"],
    fields: {
      label: field.string(),
    },
  }),
});

declare const projectRef: RowRef<"projects">;
declare const teamRef: RowRef<"teams">;
declare const userRef: RowRef<"user">;

const db = new Vennbase({
  schema: typeTestSchema,
  identityProvider: async () => ({ username: "typecheck" }),
});

// @ts-expect-error tasks require an explicit project scope on insert
void db.create("tasks", { title: "Ship v2" });
void db.create("tasks", { title: "Ship v2", points: 3 }, { in: projectRef });
// @ts-expect-error gameRecords require an explicit current-user scope on insert
void db.create("gameRecords", { gameRef: projectRef, role: "owner" });
void db.create("gameRecords", { gameRef: projectRef, role: "owner" }, { in: CURRENT_USER });
void db.create("gameRecords", { gameRef: projectRef, role: "owner" }, { in: userRef });

// @ts-expect-error tasks.title is required on insert
void db.create("tasks", {});

// @ts-expect-error tasks can only be created under projects
void db.create("tasks", { title: "Ship v2" }, { in: teamRef });

void db.query("tasks", { in: projectRef, where: { status: "done" } });
void db.query("tasks", { in: projectRef, orderBy: "status", order: "asc" });
// @ts-expect-error gameRecords require an explicit current-user scope on query
void db.query("gameRecords", { where: { role: "owner" } });
void db.query("gameRecords", { in: CURRENT_USER, where: { role: "owner" } });
void db.query("gameRecords", { in: CURRENT_USER, where: { gameRef: projectRef } });
void db.query("tasks", { in: projectRef, select: "keys", orderBy: "status" }).then((rows) => {
  const first = rows[0] as DbQueryProjectedRow<typeof typeTestSchema, "tasks"> | undefined;
  const projectedStatus: string | undefined = first?.fields.status;
  void projectedStatus;

  // @ts-expect-error key-query projections are anonymous and do not expose row refs
  void first?.ref;
});

// @ts-expect-error invalid where field
void db.query("tasks", { in: projectRef, where: { missing: "nope" } });

// @ts-expect-error title is not a key field
void db.query("tasks", { in: projectRef, where: { title: "Ship v2" } });

// @ts-expect-error title is not a key field
void db.query("tasks", { in: projectRef, orderBy: "title" });

// @ts-expect-error tasks can only be queried under projects
void db.query("tasks", { in: teamRef });

// @ts-expect-error parentless collections cannot be queried because queries always require in
void db.query("projects", {});

// @ts-expect-error mixed parent collections still require an explicit scope
void db.query("mixedRecords", { where: { label: "x" } });
void db.query("mixedRecords", { in: CURRENT_USER, where: { label: "x" } });
void db.query("mixedRecords", { in: [CURRENT_USER, projectRef], where: { label: "x" } });

// @ts-expect-error mixed parent collections still require an explicit scope on insert
void db.create("mixedRecords", { label: "x" });
void db.create("mixedRecords", { label: "x" }, { in: CURRENT_USER });
void db.create("mixedRecords", { label: "x" }, { in: [CURRENT_USER, projectRef] });

const projectWrite = db.create("projects", { name: "Website" });
const project = projectWrite.value;
const projectName: string = project.fields.name;
void projectName;
void projectWrite.committed;
void db.create("tasks", { title: "Ship v2" }, { in: project });
void db.query("tasks", { in: project, where: { status: "done" } });
void db.getRow(project).then((row) => {
  const collection: "projects" = row.collection;
  void collection;
});
const editorShareToken = db.createShareToken(project, "editor").value;
void db.createShareToken(project, "contributor");
void db.createShareToken(project, "submitter");
void db.createShareLink(project, editorShareToken);
void db.createShareLink(project, "submitter");
void db.joinInvite("https://example.com/?db=%7B%7D");
void db.listMembers(project);
void db.saveRow("recent-project", project);

// @ts-expect-error ref fields still require a serializable RowRef
void db.create("gameRecords", { gameRef: project, role: "owner" }, { in: CURRENT_USER });

const taskWrite = db.create("tasks", { title: "Ship v2" }, { in: projectRef });
const task = taskWrite.value;
const title: string = task.fields.title;
const status: string = task.fields.status;
const maybePoints: number | undefined = task.fields.points;
void title;
void status;
void maybePoints;
void taskWrite.committed;
void db.update("tasks", task, { status: "done" });
void task.in.add(project);
void task.in.list().then((parents) => {
  const firstParent = parents[0];
  if (firstParent) {
    const name: "projects" = firstParent.collection;
    void name;
  }
});

// @ts-expect-error tasks can only link to projects
void task.in.add(teamRef);

void db.getRow(projectRef).then((row) => {
  const collection: "projects" = row.collection;
  void collection;

  if (row.collection === "projects") {
    const name: string = row.fields.name;
    void name;
  }
});

// @ts-expect-error "user" is a reserved built-in collection name
defineSchema({
  user: collection({
    fields: {
      name: field.string(),
    },
  }),
});

export {};
