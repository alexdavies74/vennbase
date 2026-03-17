import { resolveBackend } from "./backend";
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateP256KeyPair,
  hashCanonicalValue,
  importP256KeyPair,
  importPublicKey,
  signCanonicalValue,
  verifyCanonicalValue,
} from "./crypto";
import type { BackendClient, PrincipalProof, ProtectedRequest, RequestProof, VerifiedPrincipal } from "./types";

interface StoredSignerKey {
  version: 1;
  username: string;
  createdAt: number;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

const SIGNER_KEY_KV_PREFIX = "putbase:signer:v1";
const DEFAULT_PRINCIPAL_TTL_MS = 60_000;
const inMemorySignerKeys = new Map<string, StoredSignerKey>();

function normalizeSignedValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function principalPayload(proof: Pick<PrincipalProof, "username" | "publicKeyJwk" | "signedAt" | "expiresAt">) {
  return {
    username: proof.username,
    publicKeyJwk: proof.publicKeyJwk,
    signedAt: proof.signedAt,
    expiresAt: proof.expiresAt,
  };
}

export function buildRequestProofPayload(args: {
  action: string;
  roomId: string;
  principalHash: string;
  payloadHash: string;
  nonce: string;
  signedAt: number;
}): object {
  return {
    action: args.action,
    roomId: args.roomId,
    principalHash: args.principalHash,
    payloadHash: args.payloadHash,
    nonce: args.nonce,
    signedAt: args.signedAt,
  };
}

export function isProtectedRequest(value: unknown): value is ProtectedRequest<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { auth?: unknown; payload?: unknown };
  if (!candidate.auth || typeof candidate.auth !== "object" || Array.isArray(candidate.auth)) {
    return false;
  }

  const auth = candidate.auth as { principal?: unknown };
  return !!auth.principal && typeof auth.principal === "object" && !Array.isArray(auth.principal);
}

export async function parseProtectedRequest<TPayload>(request: Request): Promise<ProtectedRequest<TPayload>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new Error("Request body must be valid JSON");
  }

  if (!isProtectedRequest(payload)) {
    throw new Error("Request body must include auth.principal and payload");
  }

  return payload as ProtectedRequest<TPayload>;
}

export async function createPrincipalProof(args: {
  username: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  signedAt?: number;
  expiresAt?: number;
}): Promise<PrincipalProof> {
  const signedAt = args.signedAt ?? Date.now();
  const expiresAt = args.expiresAt ?? (signedAt + DEFAULT_PRINCIPAL_TTL_MS);
  const unsigned = principalPayload({
    username: args.username,
    publicKeyJwk: args.publicKeyJwk,
    signedAt,
    expiresAt,
  });
  const signature = await signCanonicalValue(unsigned, args.privateKey);
  return {
    ...unsigned,
    signature,
  };
}

export async function verifyPrincipalProof(
  proof: PrincipalProof,
  now = Date.now(),
): Promise<VerifiedPrincipal> {
  if (!proof.username?.trim()) {
    throw new Error("Principal proof username is required");
  }
  if (!proof.publicKeyJwk || typeof proof.publicKeyJwk !== "object") {
    throw new Error("Principal proof publicKeyJwk is required");
  }
  if (!Number.isFinite(proof.signedAt) || !Number.isFinite(proof.expiresAt)) {
    throw new Error("Principal proof timestamps are invalid");
  }
  if (proof.expiresAt <= now || proof.signedAt > proof.expiresAt) {
    throw new Error("Principal proof has expired");
  }
  if (typeof proof.signature !== "string" || !proof.signature) {
    throw new Error("Principal proof signature is required");
  }

  const publicKey = await importPublicKey(proof.publicKeyJwk);
  const verified = await verifyCanonicalValue(principalPayload(proof), proof.signature, publicKey);
  if (!verified) {
    throw new Error("Principal proof signature is invalid");
  }

  return {
    username: proof.username,
    publicKeyJwk: proof.publicKeyJwk,
    publicKey,
    signedAt: proof.signedAt,
    expiresAt: proof.expiresAt,
    signature: proof.signature,
    proof,
  };
}

export async function createRequestProof(args: {
  action: string;
  roomId: string;
  payload: unknown;
  principal: PrincipalProof;
  privateKey: CryptoKey;
  nonce?: string;
  signedAt?: number;
}): Promise<RequestProof> {
  const signedAt = args.signedAt ?? Date.now();
  const nonce = args.nonce ?? crypto.randomUUID();
  const [payloadHash, principalHash] = await Promise.all([
    hashCanonicalValue(normalizeSignedValue(args.payload)),
    hashCanonicalValue(normalizeSignedValue(args.principal)),
  ]);
  const signature = await signCanonicalValue(
    buildRequestProofPayload({
      action: args.action,
      roomId: args.roomId,
      payloadHash,
      principalHash,
      nonce,
      signedAt,
    }),
    args.privateKey,
  );

  return {
    action: args.action,
    roomId: args.roomId,
    nonce,
    signedAt,
    signature,
  };
}

export async function verifyRequestProof(args: {
  proof: RequestProof | undefined;
  action: string;
  roomId: string;
  payload: unknown;
  principal: PrincipalProof;
  publicKey: CryptoKey;
}): Promise<void> {
  const proof = args.proof;
  if (!proof) {
    throw new Error("Request proof is required");
  }
  if (proof.action !== args.action) {
    throw new Error("Request proof action mismatch");
  }
  if (proof.roomId !== args.roomId) {
    throw new Error("Request proof roomId mismatch");
  }
  if (typeof proof.nonce !== "string" || !proof.nonce) {
    throw new Error("Request proof nonce is required");
  }
  if (!Number.isFinite(proof.signedAt)) {
    throw new Error("Request proof timestamp is invalid");
  }
  if (typeof proof.signature !== "string" || !proof.signature) {
    throw new Error("Request proof signature is required");
  }

  const [payloadHash, principalHash] = await Promise.all([
    hashCanonicalValue(normalizeSignedValue(args.payload)),
    hashCanonicalValue(normalizeSignedValue(args.principal)),
  ]);
  const verified = await verifyCanonicalValue(
    buildRequestProofPayload({
      action: args.action,
      roomId: args.roomId,
      payloadHash,
      principalHash,
      nonce: proof.nonce,
      signedAt: proof.signedAt,
    }),
    proof.signature,
    args.publicKey,
  );
  if (!verified) {
    throw new Error("Request proof signature is invalid");
  }
}

export class AuthManager {
  private backend: BackendClient | undefined;
  private readonly keyPairs = new Map<string, Promise<CryptoKeyPair>>();
  private readonly publicKeys = new Map<string, Promise<JsonWebKey>>();

  constructor(
    backend: BackendClient | undefined,
    private readonly getUsername: () => Promise<string>,
  ) {
    this.backend = resolveBackend(backend);
  }

  setBackend(backend: BackendClient | undefined): void {
    this.backend = resolveBackend(backend);
  }

  async getPublicKeyJwk(): Promise<JsonWebKey> {
    const username = await this.getUsername();
    const existing = this.publicKeys.get(username);
    if (existing) {
      return existing;
    }

    const promise = this.getKeyPair(username)
      .then((keyPair) => exportPublicJwk(keyPair.publicKey));
    this.publicKeys.set(username, promise);
    return promise;
  }

  async createProtectedRequest<TPayload>(args: {
    action: string;
    roomId: string;
    payload: TPayload;
    includeRequestProof?: boolean;
  }): Promise<ProtectedRequest<TPayload>> {
    const username = await this.getUsername();
    const keyPair = await this.getKeyPair(username);
    const publicKeyJwk = await this.getPublicKeyJwk();
    const principal = await createPrincipalProof({
      username,
      publicKeyJwk,
      privateKey: keyPair.privateKey,
    });

    const auth: ProtectedRequest<TPayload>["auth"] = { principal };
    if (args.includeRequestProof !== false) {
      auth.request = await createRequestProof({
        action: args.action,
        roomId: args.roomId,
        payload: args.payload,
        principal,
        privateKey: keyPair.privateKey,
      });
    }

    return {
      auth,
      payload: args.payload,
    };
  }

  private async getKeyPair(username: string): Promise<CryptoKeyPair> {
    const existing = this.keyPairs.get(username);
    if (existing) {
      return existing;
    }

    const promise = this.loadOrCreateKeyPair(username);
    this.keyPairs.set(username, promise);
    return promise;
  }

  private async loadOrCreateKeyPair(username: string): Promise<CryptoKeyPair> {
    const restored = await this.loadKeyPair(username);
    if (restored) {
      return importP256KeyPair({
        publicKeyJwk: restored.publicKeyJwk,
        privateKeyJwk: restored.privateKeyJwk,
      });
    }

    const keyPair = await generateP256KeyPair();
    const [publicKeyJwk, privateKeyJwk] = await Promise.all([
      exportPublicJwk(keyPair.publicKey),
      exportPrivateJwk(keyPair.privateKey),
    ]);
    const stored: StoredSignerKey = {
      version: 1,
      username,
      createdAt: Date.now(),
      publicKeyJwk,
      privateKeyJwk,
    };
    await this.saveKeyPair(username, stored);
    return keyPair;
  }

  private async loadKeyPair(username: string): Promise<StoredSignerKey | null> {
    const key = `${SIGNER_KEY_KV_PREFIX}:${username}`;
    const backend = resolveBackend(this.backend);
    const kv = backend?.kv;
    const stored = kv?.get
      ? await kv.get<unknown>(key).catch(() => undefined)
      : inMemorySignerKeys.get(key);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      return null;
    }

    const candidate = stored as Partial<StoredSignerKey>;
    if (
      candidate.version !== 1
      || candidate.username !== username
      || !candidate.publicKeyJwk
      || !candidate.privateKeyJwk
    ) {
      return null;
    }

    return candidate as StoredSignerKey;
  }

  private async saveKeyPair(username: string, stored: StoredSignerKey): Promise<void> {
    const key = `${SIGNER_KEY_KV_PREFIX}:${username}`;
    const backend = resolveBackend(this.backend);
    const kv = backend?.kv;
    if (kv?.set) {
      await kv.set(key, stored).catch(() => undefined);
      return;
    }

    inMemorySignerKeys.set(key, stored);
  }
}
