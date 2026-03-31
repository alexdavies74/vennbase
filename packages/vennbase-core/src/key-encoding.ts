import type { JsonValue } from "./types";
import { stableJsonStringify } from "./stable-json";

const NULL_SENTINEL = "\\x00";

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return `nan:${String(value)}`;
  }

  const rounded = Math.trunc(value);
  if (rounded >= 0) {
    return `n:${String(rounded).padStart(16, "0")}`;
  }

  const magnitude = String(Math.abs(rounded)).padStart(16, "0");
  return `n:-${magnitude}`;
}

export function encodeFieldValue(value: JsonValue): string {
  if (value === null) {
    return NULL_SENTINEL;
  }

  if (typeof value === "string") {
    return `s:${encodeURIComponent(value)}`;
  }

  if (typeof value === "number") {
    return encodeNumber(value);
  }

  if (typeof value === "boolean") {
    return value ? "b:1" : "b:0";
  }

  if (Array.isArray(value) || typeof value === "object") {
    return `j:${encodeURIComponent(stableJsonStringify(value))}`;
  }

  return `u:${encodeURIComponent(String(value))}`;
}

export function encodeCompositeFieldValues(values: JsonValue[]): string {
  return values.map((value) => encodeFieldValue(value)).join(":");
}
