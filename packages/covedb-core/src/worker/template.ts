import { CLASSIC_WORKER_RUNTIME, CLASSIC_WORKER_RUNTIME_ID } from "./dist/generated-runtime";

export { CLASSIC_WORKER_RUNTIME_ID };

function escapeForLiteral(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
}

export function buildClassicWorkerScript(args: {
  owner: string;
  ownerPublicKeyJwk: JsonWebKey;
}): string {
  return CLASSIC_WORKER_RUNTIME
    .replaceAll("__PUTER_FED_ROW_OWNER__", escapeForLiteral(args.owner))
    .replaceAll("__COVEDB_OWNER_PUBLIC_KEY_JWK__", escapeForLiteral(JSON.stringify(args.ownerPublicKeyJwk)));
}
