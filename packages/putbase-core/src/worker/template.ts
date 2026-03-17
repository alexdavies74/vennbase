import { CLASSIC_WORKER_RUNTIME } from "./dist/generated-runtime";

function escapeForLiteral(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
}

export function buildClassicWorkerScript(args: {
  owner: string;
  ownerPublicKeyJwk: JsonWebKey;
}): string {
  return CLASSIC_WORKER_RUNTIME
    .replaceAll("__PUTER_FED_ROOM_OWNER__", escapeForLiteral(args.owner))
    .replaceAll("__PUTBASE_OWNER_PUBLIC_KEY_JWK__", escapeForLiteral(JSON.stringify(args.ownerPublicKeyJwk)));
}
