import type { MemberRole } from "./schema.js";

export type MemberRoleScope = "index" | "content" | "all";
export type MemberRoleLevel = "viewer" | "submitter" | "editor";

const MEMBER_ROLES: MemberRole[] = [
  "index-viewer",
  "index-submitter",
  "index-editor",
  "content-viewer",
  "content-submitter",
  "content-editor",
  "all-viewer",
  "all-submitter",
  "all-editor",
];

function memberRoleScopeRank(scope: MemberRoleScope): number {
  switch (scope) {
    case "index":
      return 0;
    case "content":
      return 1;
    case "all":
      return 2;
  }
}

function memberRoleLevelRank(level: MemberRoleLevel): number {
  switch (level) {
    case "viewer":
      return 0;
    case "submitter":
      return 1;
    case "editor":
      return 2;
  }
}

function someRole(roles: readonly MemberRole[], predicate: (role: MemberRole) => boolean): boolean {
  return roles.some(predicate);
}

function dedupeRoles(roles: readonly MemberRole[]): MemberRole[] {
  const seen = new Set<MemberRole>();
  const deduped: MemberRole[] = [];

  for (const role of roles) {
    if (seen.has(role)) {
      continue;
    }
    seen.add(role);
    deduped.push(role);
  }

  return deduped;
}

function roleReadsContent(role: MemberRole): boolean {
  return getMemberRoleScope(role) !== "index";
}

function roleSeesMembers(role: MemberRole): boolean {
  return getMemberRoleScope(role) === "all";
}

function roleEditsContent(role: MemberRole): boolean {
  return getMemberRoleScope(role) !== "index" && getMemberRoleLevel(role) === "editor";
}

function roleManagesMembers(role: MemberRole): boolean {
  return getMemberRoleScope(role) === "all" && getMemberRoleLevel(role) === "editor";
}

function roleMaintainsOwnChildren(role: MemberRole): boolean {
  return getMemberRoleLevel(role) !== "viewer";
}

function roleMaintainsWritableChildren(role: MemberRole): boolean {
  return getMemberRoleScope(role) === "index" && getMemberRoleLevel(role) === "editor";
}

function roleCuratesAnyChild(role: MemberRole): boolean {
  return getMemberRoleScope(role) !== "index" && getMemberRoleLevel(role) === "editor";
}

export function getMemberRoleScope(role: MemberRole): MemberRoleScope {
  switch (role) {
    case "index-viewer":
    case "index-submitter":
    case "index-editor":
      return "index";
    case "content-viewer":
    case "content-submitter":
    case "content-editor":
      return "content";
    case "all-viewer":
    case "all-submitter":
    case "all-editor":
      return "all";
  }
}

export function getMemberRoleLevel(role: MemberRole): MemberRoleLevel {
  switch (role) {
    case "index-viewer":
    case "content-viewer":
    case "all-viewer":
      return "viewer";
    case "index-submitter":
    case "content-submitter":
    case "all-submitter":
      return "submitter";
    case "index-editor":
    case "content-editor":
    case "all-editor":
      return "editor";
  }
}

export function memberRoleFromParts(scope: MemberRoleScope, level: MemberRoleLevel): MemberRole {
  switch (scope) {
    case "index":
      switch (level) {
        case "viewer":
          return "index-viewer";
        case "submitter":
          return "index-submitter";
        case "editor":
          return "index-editor";
      }
    case "content":
      switch (level) {
        case "viewer":
          return "content-viewer";
        case "submitter":
          return "content-submitter";
        case "editor":
          return "content-editor";
      }
    case "all":
      switch (level) {
        case "viewer":
          return "all-viewer";
        case "submitter":
          return "all-submitter";
        case "editor":
          return "all-editor";
      }
  }
}

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as string[]).includes(value);
}

export function normalizeStoredMemberRole(role: unknown): MemberRole | null {
  return isMemberRole(role) ? role : null;
}

export function mergeMemberRoles(
  left: readonly MemberRole[] | null | undefined,
  right: readonly MemberRole[] | null | undefined,
): MemberRole[] {
  return dedupeRoles([...(left ?? []), ...(right ?? [])]);
}

export function inheritedMemberRole(role: MemberRole | null): MemberRole | null {
  if (!role) {
    return null;
  }
  if (getMemberRoleLevel(role) !== "submitter") {
    return role;
  }
  return memberRoleFromParts(getMemberRoleScope(role), "viewer");
}

export function inheritedMemberRoles(roles: readonly MemberRole[] | null | undefined): MemberRole[] {
  return dedupeRoles(
    (roles ?? [])
      .map((role) => inheritedMemberRole(role))
      .filter((role): role is MemberRole => role !== null),
  );
}

export function canQueryIndex(roles: readonly MemberRole[]): boolean {
  return roles.length > 0;
}

export function canReadContent(roles: readonly MemberRole[]): boolean {
  return someRole(roles, roleReadsContent);
}

export function canQueryFull(roles: readonly MemberRole[]): boolean {
  return canReadContent(roles);
}

export function canPollSync(roles: readonly MemberRole[]): boolean {
  return canReadContent(roles);
}

export function canEditContent(roles: readonly MemberRole[]): boolean {
  return someRole(roles, roleEditsContent);
}

export function canSendSync(roles: readonly MemberRole[]): boolean {
  return canEditContent(roles);
}

export function canManageParents(roles: readonly MemberRole[]): boolean {
  return canEditContent(roles);
}

export function canCurateAnyChild(roles: readonly MemberRole[]): boolean {
  return someRole(roles, roleCuratesAnyChild);
}

export function canMaintainWritableChildren(roles: readonly MemberRole[]): boolean {
  return canCurateAnyChild(roles) || someRole(roles, roleMaintainsWritableChildren);
}

export function canMaintainOwnChildren(roles: readonly MemberRole[]): boolean {
  return canMaintainWritableChildren(roles) || someRole(roles, roleMaintainsOwnChildren);
}

export function canSeeMembers(roles: readonly MemberRole[]): boolean {
  return canManageMembers(roles) || someRole(roles, roleSeesMembers);
}

export function canManageMembers(roles: readonly MemberRole[]): boolean {
  return someRole(roles, roleManagesMembers);
}

export function canMintInviteRole(inviterRoles: readonly MemberRole[], requestedRole: MemberRole): boolean {
  const requestedScopeRank = memberRoleScopeRank(getMemberRoleScope(requestedRole));
  const requestedLevelRank = memberRoleLevelRank(getMemberRoleLevel(requestedRole));

  return inviterRoles.some((inviterRole) =>
    memberRoleScopeRank(getMemberRoleScope(inviterRole)) >= requestedScopeRank
    && memberRoleLevelRank(getMemberRoleLevel(inviterRole)) >= requestedLevelRank,
  );
}
