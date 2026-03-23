import type { MutationReceipt } from "./mutation-receipt";
import type { DbMemberInfo, DbRowLocator, DbRowRef, DbSchema, MemberRole } from "./schema";
import type { InviteToken, JsonValue } from "./types";

type RowKey = string;

export interface OptimisticRowRecord {
  row: DbRowRef;
  collection: string;
  baseFields: Record<string, JsonValue>;
  overlayFields: Record<string, JsonValue>;
  knownParents: DbRowRef[] | null;
  pendingCreate: boolean;
  pendingCreateReceipt: Promise<unknown> | null;
  pendingParentAdds: DbRowRef[];
  pendingParentRemoves: DbRowRef[];
  directMembers: Array<{ username: string; role: MemberRole }> | null;
  pendingMemberAdds: Array<{ username: string; role: MemberRole }>;
  pendingMemberRemoves: string[];
  pendingInviteToken: InviteToken | null;
}

function rowKey(row: Pick<DbRowLocator, "id" | "owner" | "target">): RowKey {
  return `${row.owner}:${row.id}:${row.target}`;
}

function sameRow(left: Pick<DbRowLocator, "id" | "owner" | "target">, right: Pick<DbRowLocator, "id" | "owner" | "target">): boolean {
  return left.id === right.id && left.owner === right.owner && left.target === right.target;
}

function mergeUniqueRows(left: DbRowRef[], additions: DbRowRef[]): DbRowRef[] {
  const next = [...left];
  for (const row of additions) {
    if (!next.some((candidate) => sameRow(candidate, row))) {
      next.push(row);
    }
  }
  return next;
}

function removeRows(left: DbRowRef[], removals: DbRowRef[]): DbRowRef[] {
  return left.filter((candidate) => !removals.some((row) => sameRow(candidate, row)));
}

function mergeMembers(
  base: Array<{ username: string; role: MemberRole }>,
  adds: Array<{ username: string; role: MemberRole }>,
  removals: string[],
): Array<{ username: string; role: MemberRole }> {
  const filtered = base.filter((member) => !removals.includes(member.username));
  for (const member of adds) {
    const index = filtered.findIndex((candidate) => candidate.username === member.username);
    if (index >= 0) {
      filtered[index] = member;
    } else {
      filtered.push(member);
    }
  }
  return filtered;
}

export class OptimisticStore {
  private readonly rows = new Map<RowKey, OptimisticRowRecord>();
  private readonly targets = new Map<string, RowKey>();

  private ensureRecord(args: {
    row: DbRowRef;
    collection: string;
    baseFields?: Record<string, JsonValue>;
  }): OptimisticRowRecord {
    const key = rowKey(args.row);
    const existing = this.rows.get(key);
    if (existing) {
      return existing;
    }

    const created: OptimisticRowRecord = {
      row: args.row,
      collection: args.collection,
      baseFields: { ...(args.baseFields ?? {}) },
      overlayFields: {},
      knownParents: null,
      pendingCreate: false,
      pendingCreateReceipt: null,
      pendingParentAdds: [],
      pendingParentRemoves: [],
      directMembers: null,
      pendingMemberAdds: [],
      pendingMemberRemoves: [],
      pendingInviteToken: null,
    };

    this.rows.set(key, created);
    this.targets.set(args.row.target, key);
    return created;
  }

  upsertBaseRow(
    row: DbRowRef,
    collection: string,
    fields: Record<string, JsonValue>,
    parents?: DbRowRef[] | null,
  ): void {
    const record = this.ensureRecord({ row, collection, baseFields: fields });
    record.collection = collection;
    record.baseFields = { ...fields };
    if (parents !== undefined) {
      record.knownParents = parents ? [...parents] : null;
    }
  }

  beginCreate(args: {
    row: DbRowRef;
    collection: string;
    fields: Record<string, JsonValue>;
    parents: DbRowRef[];
    receipt: MutationReceipt<unknown>;
  }): void {
    const record = this.ensureRecord({
      row: args.row,
      collection: args.collection,
      baseFields: args.fields,
    });
    record.pendingCreate = true;
    record.pendingCreateReceipt = args.receipt.settled;
    record.knownParents = [...args.parents];
    record.baseFields = { ...args.fields };
    record.overlayFields = {};
  }

  confirmCreate(row: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingCreate = false;
    record.pendingCreateReceipt = null;
  }

  rollbackCreate(row: DbRowRef): void {
    const key = rowKey(row);
    const record = this.rows.get(key);
    if (!record) {
      return;
    }
    this.rows.delete(key);
    this.targets.delete(record.row.target);
  }

  applyOverlay(row: DbRowRef, collection: string, fields: Record<string, JsonValue>): Record<string, JsonValue> {
    const record = this.ensureRecord({ row, collection });
    record.overlayFields = {
      ...record.overlayFields,
      ...fields,
    };
    return this.getLogicalFields(row) ?? { ...record.baseFields, ...record.overlayFields };
  }

  commitOverlay(row: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.baseFields = {
      ...record.baseFields,
      ...record.overlayFields,
    };
    record.overlayFields = {};
  }

  rollbackOverlay(row: DbRowRef, fields: Record<string, JsonValue>): void {
    const record = this.ensureRecord({ row, collection: row.collection, baseFields: fields });
    record.overlayFields = {};
    record.baseFields = { ...fields };
  }

  getLogicalFields(row: Pick<DbRowLocator, "id" | "owner" | "target">): Record<string, JsonValue> | null {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return null;
    }
    return {
      ...record.baseFields,
      ...record.overlayFields,
    };
  }

  getCollection(row: Pick<DbRowLocator, "id" | "owner" | "target">): string | null {
    return this.rows.get(rowKey(row))?.collection ?? null;
  }

  getRowByTarget(target: string): OptimisticRowRecord | null {
    const key = this.targets.get(target);
    return key ? this.rows.get(key) ?? null : null;
  }

  getPendingCreateDependency(row: Pick<DbRowLocator, "id" | "owner" | "target">): Promise<unknown> | null {
    return this.rows.get(rowKey(row))?.pendingCreateReceipt ?? null;
  }

  hasPendingCreate(row: Pick<DbRowLocator, "id" | "owner" | "target">): boolean {
    return this.rows.get(rowKey(row))?.pendingCreate ?? false;
  }

  recordParents(row: DbRowRef, parents: DbRowRef[]): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.knownParents = [...parents];
  }

  addParent(row: DbRowRef, parent: DbRowRef): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.pendingParentRemoves = record.pendingParentRemoves.filter((candidate) => !sameRow(candidate, parent));
    if (!record.pendingParentAdds.some((candidate) => sameRow(candidate, parent))) {
      record.pendingParentAdds.push(parent);
    }
  }

  removeParent(row: DbRowRef, parent: DbRowRef): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.pendingParentAdds = record.pendingParentAdds.filter((candidate) => !sameRow(candidate, parent));
    if (!record.pendingParentRemoves.some((candidate) => sameRow(candidate, parent))) {
      record.pendingParentRemoves.push(parent);
    }
  }

  confirmParentAdd(row: DbRowRef, parent: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentAdds = record.pendingParentAdds.filter((candidate) => !sameRow(candidate, parent));
    record.knownParents = mergeUniqueRows(record.knownParents ?? [], [parent]);
  }

  rollbackParentAdd(row: DbRowRef, parent: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentAdds = record.pendingParentAdds.filter((candidate) => !sameRow(candidate, parent));
  }

  confirmParentRemove(row: DbRowRef, parent: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentRemoves = record.pendingParentRemoves.filter((candidate) => !sameRow(candidate, parent));
    record.knownParents = removeRows(record.knownParents ?? [], [parent]);
  }

  rollbackParentRemove(row: DbRowRef, parent: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentRemoves = record.pendingParentRemoves.filter((candidate) => !sameRow(candidate, parent));
  }

  getCurrentParents(row: DbRowRef, serverParents: DbRowRef[] = []): DbRowRef[] {
    const record = this.rows.get(rowKey(row));
    const base = record?.knownParents ?? serverParents;
    if (!record) {
      return [...base];
    }
    return removeRows(mergeUniqueRows([...base], record.pendingParentAdds), record.pendingParentRemoves);
  }

  getOptimisticQueryRows(collection: string, parents: DbRowRef[]): OptimisticRowRecord[] {
    return Array.from(this.rows.values()).filter((record) => {
      if (record.collection !== collection) {
        return false;
      }
      const currentParents = this.getCurrentParents(record.row, []);
      return currentParents.some((parent) => parents.some((candidate) => sameRow(candidate, parent)));
    });
  }

  shouldExcludeFromParent(row: DbRowRef, parent: DbRowRef): boolean {
    const record = this.rows.get(rowKey(row));
    return record?.pendingParentRemoves.some((candidate) => sameRow(candidate, parent)) ?? false;
  }

  recordDirectMembers(row: DbRowRef, members: Array<{ username: string; role: MemberRole }>): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.directMembers = [...members];
  }

  addMember(row: DbRowRef, username: string, role: MemberRole): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.pendingMemberRemoves = record.pendingMemberRemoves.filter((candidate) => candidate !== username);
    const existingIndex = record.pendingMemberAdds.findIndex((candidate) => candidate.username === username);
    if (existingIndex >= 0) {
      record.pendingMemberAdds[existingIndex] = { username, role };
    } else {
      record.pendingMemberAdds.push({ username, role });
    }
  }

  removeMember(row: DbRowRef, username: string): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.pendingMemberAdds = record.pendingMemberAdds.filter((candidate) => candidate.username !== username);
    if (!record.pendingMemberRemoves.includes(username)) {
      record.pendingMemberRemoves.push(username);
    }
  }

  confirmMemberMutation(row: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.directMembers = mergeMembers(record.directMembers ?? [], record.pendingMemberAdds, record.pendingMemberRemoves);
    record.pendingMemberAdds = [];
    record.pendingMemberRemoves = [];
  }

  rollbackMemberMutation(row: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingMemberAdds = [];
    record.pendingMemberRemoves = [];
  }

  getDirectMembers(row: DbRowRef): Array<{ username: string; role: MemberRole }> | null {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return null;
    }
    return mergeMembers(record.directMembers ?? [], record.pendingMemberAdds, record.pendingMemberRemoves);
  }

  getMemberUsernames(row: DbRowRef): string[] | null {
    const direct = this.getDirectMembers(row);
    return direct ? direct.map((member) => member.username) : null;
  }

  getEffectiveMembers<Schema extends DbSchema>(
    row: DbRowRef,
    base: Array<DbMemberInfo<Schema>>,
  ): Array<DbMemberInfo<Schema>> {
    const direct = this.getDirectMembers(row);
    if (!direct) {
      return base;
    }

    const byUsername = new Map(base.map((member) => [member.username, member]));
    for (const member of direct) {
      byUsername.set(member.username, {
        username: member.username,
        role: member.role,
        via: "direct",
      } as DbMemberInfo<Schema>);
    }
    return Array.from(byUsername.values());
  }

  setInviteToken(row: DbRowRef, inviteToken: InviteToken): void {
    const record = this.ensureRecord({ row, collection: row.collection });
    record.pendingInviteToken = inviteToken;
  }

  clearInviteToken(row: DbRowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingInviteToken = null;
  }

  getInviteToken(row: DbRowRef): InviteToken | null {
    return this.rows.get(rowKey(row))?.pendingInviteToken ?? null;
  }
}
