import { COVEDB_INVITE_TARGET_PARAM, CoveDBError } from "@covedb/core";

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CoveDBError) {
    const detailsParts: Array<string | number> = [error.code];
    if (error.status !== undefined) {
      detailsParts.push(error.status);
    }
    const details = detailsParts.join(", ");
    return details ? `${error.message} (${details})` : error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (hasStringMessage(error)) {
    return error.message;
  }

  return fallback;
}

function hasStringMessage(value: unknown): value is { message: string } {
  return (
    !!value &&
    typeof value === "object" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string" &&
    Boolean((value as { message: string }).message.trim())
  );
}

export function getInviteInputFromLocation(href: string): string | null {
  const url = new URL(href);
  return url.searchParams.has(COVEDB_INVITE_TARGET_PARAM) ? url.toString() : null;
}

export function clearInviteLocation(): void {
  const clean = new URL(window.location.href);
  clean.pathname = clean.pathname === "/join" ? "/" : clean.pathname;
  clean.search = "";
  clean.hash = "";
  window.history.replaceState({}, "", clean.toString());
}
