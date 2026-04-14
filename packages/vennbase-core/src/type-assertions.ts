import { Vennbase } from "./vennbase.js";
import {
  CURRENT_USER,
  collection,
  defineSchema,
  field,
  type DbIndexKeyProjection,
  type DbQueryOptions,
  type DbQueryRow,
  type DbQueryRows,
  type DbQuerySelect,
  type RowRef,
  isIndexKeyProjection,
  isRowRef,
  toRowRef,
} from "./schema.js";

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
      status: field.string().indexKey().default("todo"),
      points: field.number().optional(),
    },
  }),
  gameRecords: collection({
    in: ["user"],
    fields: {
      gameRef: field.ref("projects").indexKey(),
      role: field.string().indexKey(),
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
void db.query("tasks", { in: projectRef, select: "indexKeys", orderBy: "status" }).then((rows) => {
  const first = rows[0] as DbIndexKeyProjection<typeof typeTestSchema, "tasks"> | undefined;
  const projectedStatus: string | undefined = first?.fields.status;
  void projectedStatus;

  // @ts-expect-error index-key projections expose fields, not indexKeyFields
  void first?.indexKeyFields;

  // @ts-expect-error index-key projections do not expose row refs
  void first?.ref;

  // @ts-expect-error index-key projections are not row inputs
  void db.getRow(first);
});

const taskIndexKeyOptions: DbQueryOptions<typeof typeTestSchema, "tasks", "indexKeys"> = {
  in: projectRef,
  select: "indexKeys",
  orderBy: "status",
};

const taskFullOptions: DbQueryOptions<typeof typeTestSchema, "tasks"> = {
  in: projectRef,
  orderBy: "status",
};

function firstQueryRow<
  TCollection extends keyof typeof typeTestSchema & string,
  TSelect extends DbQuerySelect = "full",
>(
  rows: DbQueryRows<typeof typeTestSchema, TCollection, TSelect>,
): DbQueryRow<typeof typeTestSchema, TCollection, TSelect> | undefined {
  return rows[0];
}

void db.query("tasks", taskIndexKeyOptions).then((rows) => {
  const first = firstQueryRow(rows);
  const projectedStatus: string | undefined = first?.fields.status;
  void projectedStatus;
});

void db.query("tasks", taskFullOptions).then((rows) => {
  const first = firstQueryRow(rows);
  const taskTitle: string | undefined = first?.fields.title;
  void taskTitle;
  if (first) {
    const ref = toRowRef(first);
    const taskCollection: "tasks" = ref.collection;
    void taskCollection;
  }
});

declare const maybeTaskQueryRow: DbQueryRow<typeof typeTestSchema, "tasks", DbQuerySelect> | undefined;
if (maybeTaskQueryRow && isIndexKeyProjection(maybeTaskQueryRow)) {
  const projectedStatus: string | undefined = maybeTaskQueryRow.fields.status;
  void projectedStatus;

  // @ts-expect-error index-key projections expose fields, not indexKeyFields
  void maybeTaskQueryRow.indexKeyFields;

  // @ts-expect-error index-key projections do not expose row refs
  void maybeTaskQueryRow.ref;
} else if (maybeTaskQueryRow) {
  const taskTitle: string = maybeTaskQueryRow.fields.title;
  const taskRef = toRowRef(maybeTaskQueryRow);
  void taskTitle;
  void taskRef;
}

// @ts-expect-error invalid where field
void db.query("tasks", { in: projectRef, where: { missing: "nope" } });

// @ts-expect-error title is not an index-key field
void db.query("tasks", { in: projectRef, where: { title: "Ship v2" } });

// @ts-expect-error title is not an index-key field
void db.query("tasks", { in: projectRef, orderBy: "title" });

// @ts-expect-error tasks can only be queried under projects
void db.query("tasks", { in: teamRef });

// @ts-expect-error parentless collections cannot be queried because queries always require in
void db.query("projects", {});

const zeroIndexMixedOrderQuery = db.query("mixedRecords", {
  in: CURRENT_USER,
  // @ts-expect-error zero-index collections cannot order queries
  orderBy: "label",
});
const zeroIndexMixedOrderRows: Promise<DbQueryRows<typeof typeTestSchema, "mixedRecords">> = zeroIndexMixedOrderQuery;
void zeroIndexMixedOrderRows;

const zeroIndexMixedWhereQuery = db.query("mixedRecords", {
  in: CURRENT_USER,
  // @ts-expect-error zero-index collections cannot filter queries
  where: { label: "x" },
});
const zeroIndexMixedWhereRows: Promise<DbQueryRows<typeof typeTestSchema, "mixedRecords">> = zeroIndexMixedWhereQuery;
void zeroIndexMixedWhereRows;

// @ts-expect-error mixed parent collections still require an explicit scope
void db.query("mixedRecords", { where: { label: "x" } });
// @ts-expect-error zero-index collections cannot filter queries
void db.query("mixedRecords", { in: CURRENT_USER, where: { label: "x" } });
// @ts-expect-error zero-index collections cannot filter queries
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
const editorShareToken = db.createShareToken(project, "all-editor").value;
void db.createShareToken(project, "content-submitter");
void db.createShareToken(project, "index-submitter");
void db.createShareLink(project, editorShareToken);
void db.createShareLink(project, "index-submitter");
void db.joinInvite("https://example.com/?db=%7B%7D");
void db.listMembers(project);
void db.saveRow("recent-project", project);
void db.openSavedRow("recent-project", "projects").then((saved) => {
  const collection: "projects" | undefined = saved?.collection;
  void collection;
});
const projectRowRef = toRowRef(project);
const projectRefStillTyped: RowRef<"projects"> = projectRowRef;
void projectRefStillTyped;
declare const maybeUnknownRow: unknown;
if (isRowRef<"projects">(maybeUnknownRow)) {
  const typedProjectRef: RowRef<"projects"> = maybeUnknownRow;
  void typedProjectRef;
}

// @ts-expect-error ref fields still require a serializable RowRef
void db.create("gameRecords", { gameRef: project, role: "owner" }, { in: CURRENT_USER });
// @ts-expect-error addMember has been removed; membership must be granted via invite joins
void db.addMember(project, "alice", "all-editor");
// @ts-expect-error row-handle direct membership grants have been removed
void project.members.add("alice", "all-editor");

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
