import type { MutationReceipt } from "./mutation-receipt.js";
import type { DbMemberInfo, DbSchema, MemberRole, RowRef } from "./schema.js";
import { rowRefKey, sameRowRef } from "./row-reference.js";
import type { JsonValue, ShareToken } from "./types.js";

type RowKey = string;

export interface OptimisticRowRecord {
  row: RowRef;
  owner: string;
  collection: string;
  baseFields: Record<string, JsonValue>;
  overlayFields: Record<string, JsonValue>;
  knownParents: RowRef[] | null;
  pendingCreate: boolean;
  pendingCreateReceipt: Promise<unknown> | null;
  pendingParentAdds: RowRef[];
  pendingParentRemoves: RowRef[];
  directMembers: Array<{ username: string; role: MemberRole }> | null;
  pendingMemberAdds: Array<{ username: string; role: MemberRole }>;
  pendingMemberRemoves: string[];
  pendingShareTokens: ShareToken[];
}

function rowKey(row: Pick<RowRef, "id" | "baseUrl">): RowKey {
  return rowRefKey(row);
}

function mergeUniqueRows(left: RowRef[], additions: RowRef[]): RowRef[] {
  const next = [...left];
  for (const row of additions) {
    if (!next.some((candidate) => sameRowRef(candidate, row))) {
      next.push(row);
    }
  }
  return next;
}

function removeRows(left: RowRef[], removals: RowRef[]): RowRef[] {
  return left.filter((candidate) => !removals.some((row) => sameRowRef(candidate, row)));
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

  private ensureRecord(args: {
    row: RowRef;
    owner: string;
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
      owner: args.owner,
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
      pendingShareTokens: [],
    };

    this.rows.set(key, created);
    return created;
  }

  upsertBaseRow(
    row: RowRef,
    owner: string,
    collection: string,
    fields: Record<string, JsonValue>,
    parents?: RowRef[] | null,
  ): void {
    const record = this.ensureRecord({ row, owner, collection, baseFields: fields });
    record.owner = owner;
    record.collection = collection;
    record.baseFields = { ...fields };
    if (parents !== undefined) {
      record.knownParents = parents ? [...parents] : null;
    }
  }

  beginCreate(args: {
    row: RowRef;
    owner: string;
    collection: string;
    fields: Record<string, JsonValue>;
    parents: RowRef[];
    receipt: MutationReceipt<unknown>;
  }): void {
    const record = this.ensureRecord({
      row: args.row,
      owner: args.owner,
      collection: args.collection,
      baseFields: args.fields,
    });
    record.owner = args.owner;
    record.pendingCreate = true;
    record.pendingCreateReceipt = args.receipt.committed;
    record.knownParents = [...args.parents];
    record.baseFields = { ...args.fields };
    record.overlayFields = {};
  }

  confirmCreate(row: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingCreate = false;
    record.pendingCreateReceipt = null;
  }

  rollbackCreate(row: RowRef): void {
    const key = rowKey(row);
    const record = this.rows.get(key);
    if (!record) {
      return;
    }
    this.rows.delete(key);
  }

  applyOverlay(row: RowRef, collection: string, fields: Record<string, JsonValue>): Record<string, JsonValue> {
    const record = this.ensureRecord({ row, owner: "", collection });
    record.overlayFields = {
      ...record.overlayFields,
      ...fields,
    };
    return this.getLogicalFields(row) ?? { ...record.baseFields, ...record.overlayFields };
  }

  commitOverlay(row: RowRef): void {
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

  rollbackOverlay(row: RowRef, fields: Record<string, JsonValue>): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection, baseFields: fields });
    record.overlayFields = {};
    record.baseFields = { ...fields };
  }

  getLogicalFields(row: Pick<RowRef, "id" | "baseUrl">): Record<string, JsonValue> | null {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return null;
    }
    return {
      ...record.baseFields,
      ...record.overlayFields,
    };
  }

  getCollection(row: Pick<RowRef, "id" | "baseUrl">): string | null {
    return this.rows.get(rowKey(row))?.collection ?? null;
  }

  getOwner(row: Pick<RowRef, "id" | "baseUrl">): string | null {
    const owner = this.rows.get(rowKey(row))?.owner ?? null;
    return owner && owner.length > 0 ? owner : null;
  }

  getRowByRef(row: Pick<RowRef, "id" | "baseUrl">): OptimisticRowRecord | null {
    return this.rows.get(rowKey(row)) ?? null;
  }

  getPendingCreateDependency(row: Pick<RowRef, "id" | "baseUrl">): Promise<unknown> | null {
    return this.rows.get(rowKey(row))?.pendingCreateReceipt ?? null;
  }

  hasPendingCreate(row: Pick<RowRef, "id" | "baseUrl">): boolean {
    return this.rows.get(rowKey(row))?.pendingCreate ?? false;
  }

  recordParents(row: RowRef, parents: RowRef[]): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.knownParents = [...parents];
  }

  recordParent(row: RowRef, parent: RowRef): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.knownParents = mergeUniqueRows(record.knownParents ?? [], [parent]);
  }

  addParent(row: RowRef, parent: RowRef): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.pendingParentRemoves = record.pendingParentRemoves.filter((candidate) => !sameRowRef(candidate, parent));
    if (!record.pendingParentAdds.some((candidate) => sameRowRef(candidate, parent))) {
      record.pendingParentAdds.push(parent);
    }
  }

  removeParent(row: RowRef, parent: RowRef): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.pendingParentAdds = record.pendingParentAdds.filter((candidate) => !sameRowRef(candidate, parent));
    if (!record.pendingParentRemoves.some((candidate) => sameRowRef(candidate, parent))) {
      record.pendingParentRemoves.push(parent);
    }
  }

  confirmParentAdd(row: RowRef, parent: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentAdds = record.pendingParentAdds.filter((candidate) => !sameRowRef(candidate, parent));
    record.knownParents = mergeUniqueRows(record.knownParents ?? [], [parent]);
  }

  rollbackParentAdd(row: RowRef, parent: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentAdds = record.pendingParentAdds.filter((candidate) => !sameRowRef(candidate, parent));
  }

  confirmParentRemove(row: RowRef, parent: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentRemoves = record.pendingParentRemoves.filter((candidate) => !sameRowRef(candidate, parent));
    record.knownParents = removeRows(record.knownParents ?? [], [parent]);
  }

  rollbackParentRemove(row: RowRef, parent: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingParentRemoves = record.pendingParentRemoves.filter((candidate) => !sameRowRef(candidate, parent));
  }

  getCurrentParents(row: RowRef, serverParents: RowRef[] = []): RowRef[] {
    const record = this.rows.get(rowKey(row));
    const base = record?.knownParents ?? serverParents;
    if (!record) {
      return [...base];
    }
    return removeRows(mergeUniqueRows([...base], record.pendingParentAdds), record.pendingParentRemoves);
  }

  getOptimisticQueryRows(collection: string, parents: RowRef[]): OptimisticRowRecord[] {
    return Array.from(this.rows.values()).filter((record) => {
      if (record.collection !== collection) {
        return false;
      }
      const currentParents = this.getCurrentParents(record.row, []);
      return currentParents.some((parent) => parents.some((candidate) => sameRowRef(candidate, parent)));
    });
  }

  findAnonymousQueryRow(collection: string, rowId: string): OptimisticRowRecord | null {
    return Array.from(this.rows.values()).find((record) => {
      return record.collection === collection && record.row.id === rowId;
    }) ?? null;
  }

  shouldExcludeFromParent(row: RowRef, parent: RowRef): boolean {
    const record = this.rows.get(rowKey(row));
    return record?.pendingParentRemoves.some((candidate) => sameRowRef(candidate, parent)) ?? false;
  }

  recordDirectMembers(row: RowRef, members: Array<{ username: string; role: MemberRole }>): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.directMembers = [...members];
  }

  addMember(row: RowRef, username: string, role: MemberRole): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.pendingMemberRemoves = record.pendingMemberRemoves.filter((candidate) => candidate !== username);
    const existingIndex = record.pendingMemberAdds.findIndex((candidate) => candidate.username === username);
    if (existingIndex >= 0) {
      record.pendingMemberAdds[existingIndex] = { username, role };
    } else {
      record.pendingMemberAdds.push({ username, role });
    }
  }

  removeMember(row: RowRef, username: string): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    record.pendingMemberAdds = record.pendingMemberAdds.filter((candidate) => candidate.username !== username);
    if (!record.pendingMemberRemoves.includes(username)) {
      record.pendingMemberRemoves.push(username);
    }
  }

  confirmMemberMutation(row: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.directMembers = mergeMembers(record.directMembers ?? [], record.pendingMemberAdds, record.pendingMemberRemoves);
    record.pendingMemberAdds = [];
    record.pendingMemberRemoves = [];
  }

  rollbackMemberMutation(row: RowRef): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingMemberAdds = [];
    record.pendingMemberRemoves = [];
  }

  getDirectMembers(row: RowRef): Array<{ username: string; role: MemberRole }> | null {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return null;
    }
    return mergeMembers(record.directMembers ?? [], record.pendingMemberAdds, record.pendingMemberRemoves);
  }

  getMemberUsernames(row: RowRef): string[] | null {
    const direct = this.getDirectMembers(row);
    return direct ? direct.map((member) => member.username) : null;
  }

  getEffectiveMembers<Schema extends DbSchema>(
    row: RowRef,
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

  setShareToken(row: RowRef, shareToken: ShareToken): void {
    const record = this.ensureRecord({ row, owner: "", collection: row.collection });
    const existingIndex = record.pendingShareTokens.findIndex((candidate) => candidate.role === shareToken.role);
    if (existingIndex >= 0) {
      record.pendingShareTokens[existingIndex] = shareToken;
      return;
    }

    record.pendingShareTokens.push(shareToken);
  }

  clearShareToken(row: RowRef, role: MemberRole): void {
    const record = this.rows.get(rowKey(row));
    if (!record) {
      return;
    }
    record.pendingShareTokens = record.pendingShareTokens.filter(
      (candidate) => candidate.role !== role,
    );
  }

  getShareToken(row: RowRef, role: MemberRole): ShareToken | null {
    return this.rows.get(rowKey(row))?.pendingShareTokens.find(
      (candidate) => candidate.role === role,
    ) ?? null;
  }
}
