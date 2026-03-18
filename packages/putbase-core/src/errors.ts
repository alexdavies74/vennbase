import type { ApiError, ErrorCode } from "./types";

const PUTER_SETUP_HINT = "Load puter.js from https://js.puter.com/v2/, import @heyputer/puter.js, or pass backend to new PutBase(...).";

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

export function missingPuterClientMessage(): string {
  return `No Puter client found. ${PUTER_SETUP_HINT}`;
}

export function missingPuterProvisioningMessage(): string {
  return `Unable to provision the federation worker because no compatible Puter client with workers.create is available. ${PUTER_SETUP_HINT}`;
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
