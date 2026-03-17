import type { Puter } from "@heyputer/puter.js";
import type { DbRowRef } from "./schema";

export type BackendClient = Pick<Puter, "auth" | "getUser" | "fs" | "workers" | "kv">;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type ErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_SIGNATURE"
  | "INVITE_REQUIRED"
  | "KEY_MISMATCH"
  | "BAD_REQUEST";

export interface ApiError {
  code: ErrorCode;
  message: string;
}

export interface RoomUser {
  username: string;
}

export interface Room {
  id: string;
  name: string;
  owner: string;
  workerUrl: string;
  createdAt: number;
}

export interface Message {
  id: string;
  roomId: string;
  body: JsonValue;
  createdAt: number;
  signedBy: string;
  sequence: number;
}

export interface InviteToken {
  token: string;
  roomId: string;
  invitedBy: string;
  createdAt: number;
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
  roomId: string;
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
  applyRemoteUpdate: (body: JsonValue, message: Message) => void;
  produceLocalUpdate: () => JsonValue | null;
}

export interface CrdtConnection {
  disconnect(): void;
  flush(): Promise<void>;
}

export interface ParsedInviteInput {
  workerUrl: string;
  inviteToken?: string;
}

export interface DeployWorkerArgs {
  owner: string;
  roomId: string;
  roomName: string;
  script: string;
  ownerPublicKeyJwk?: JsonWebKey;
  workerName?: string;
  workerVersion?: number;
  appHostname?: string;
  appHostHash?: string;
}

export interface RoomSnapshot extends Room {
  collection: string | null;
  members: string[];
  parentRefs: DbRowRef[];
}
