import type { ApiError, ErrorCode } from "./types";

export class PutBaseError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly logs?: string[];

  constructor(apiError: ApiError, status?: number) {
    super(apiError.message);
    this.name = "PutBaseError";
    this.code = apiError.code;
    this.status = status;
    this.logs = Array.isArray(apiError.logs) ? apiError.logs : undefined;
  }
}

export function toApiError(maybeError: unknown): ApiError {
  if (
    maybeError &&
    typeof maybeError === "object" &&
    "code" in maybeError &&
    "message" in maybeError
  ) {
    return maybeError as ApiError;
  }

  return {
    code: "BAD_REQUEST",
    message: "Unknown API error",
  };
}
