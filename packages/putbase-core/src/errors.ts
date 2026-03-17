import type { ApiError, ErrorCode } from "./types";

export class PutBaseError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(apiError: ApiError, status?: number) {
    super(apiError.message);
    this.name = "PutBaseError";
    this.code = apiError.code;
    this.status = status;
  }
}

export function signedOutError(message = "Not signed in. Call signIn() first."): PutBaseError {
  return new PutBaseError({
    code: "SIGNED_OUT",
    message,
  });
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
