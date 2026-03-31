import type { KV, Puter } from "@heyputer/puter.js";
import type { MemberRole, RowRef } from "./schema";

export interface BackendKv extends Pick<KV, "get" | "set"> {
  delete(key: string): Promise<unknown>;
}

export type BackendClient = Pick<Puter, "auth" | "getUser" | "fs" | "workers"> & {
  kv?: BackendKv;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | RowRef
  | { [key: string]: JsonValue }
  | JsonValue[];

export type ErrorCode =
  | "SIGNED_OUT"
  | "UNAUTHORIZED"
  | "INVALID_SIGNATURE"
  | "INVITE_REQUIRED"
  | "KEY_MISMATCH"
  | "BAD_REQUEST";

export interface ApiError {
  code: ErrorCode;
  message: string;
}

export interface VennbaseUser {
  username: string;
}

export type AuthSession =
  | { signedIn: false }
  | { signedIn: true; user: VennbaseUser };

export interface Row {
  id: string;
  name: string;
  owner: string;
  baseUrl: string;
  createdAt: number;
}

export interface SyncMessage {
  id: string;
  rowId: string;
  body: JsonValue;
  createdAt: number;
  signedBy: string;
  sequence: number;
}

export interface ShareToken {
  token: string;
  rowId: string;
  invitedBy: string;
  createdAt: number;
  role: MemberRole;
}

export interface JoinOptions {
  inviteToken?: string;
}

export interface PrincipalProof {
  username: string;
  publicKeyJwk: JsonWebKey;
  signedAt: number;
  expiresAt: number;
  signature: string;
}

export interface RequestProof {
  action: string;
  rowId: string;
  nonce: string;
  signedAt: number;
  signature: string;
}

export interface ProtectedRequest<TPayload> {
  auth: {
    principal: PrincipalProof;
    request?: RequestProof;
  };
  payload: TPayload;
}

export interface VerifiedPrincipal {
  username: string;
  publicKeyJwk: JsonWebKey;
  publicKey: CryptoKey;
  signedAt: number;
  expiresAt: number;
  signature: string;
  proof: PrincipalProof;
}

export interface CrdtConnectCallbacks {
  applyRemoteUpdate: (body: JsonValue, message: SyncMessage) => void;
  produceLocalUpdate: () => JsonValue | null;
}

export interface CrdtAdapter<TValue> {
  callbacks: CrdtConnectCallbacks;
  getValue(): TValue;
  getVersion(): number;
  subscribe(listener: () => void): () => void;
  reset(): void;
}

export interface CrdtConnection {
  disconnect(): void;
  flush(): Promise<void>;
}

export interface ParsedInvite {
  ref: RowRef;
  shareToken?: string;
}

export interface DeployWorkerArgs {
  owner: string;
  rowId: string;
  rowName: string;
  script: string;
  ownerPublicKeyJwk?: JsonWebKey;
  workerName?: string;
  workerVersion?: number;
  appHostname?: string;
  appHostHash?: string;
}

export interface RowSnapshot extends Row {
  collection: string | null;
  members: string[];
  parentRefs: RowRef[];
}
