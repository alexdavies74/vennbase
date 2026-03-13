import type { Puter } from "@heyputer/puter.js";

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

export interface CrdtConnectCallbacks {
  applyRemoteUpdate: (body: JsonValue, message: Message) => void;
  produceLocalUpdate: () => JsonValue | null;
}

export interface CrdtConnection {
  disconnect(): void;
  flush(): Promise<void>;
}

export interface SignerIdentity {
  username: string;
  publicKeyUrl: string;
}

export type SignedAction = "message" | "invite-token";

export interface SignedWriteEnvelope<TPayload extends object> {
  action: SignedAction;
  payload: TPayload;
  signer: SignerIdentity;
  signedAt: number;
  algorithm: "ECDSA_P256_SHA256";
  signature: string;
}

export interface PublicKeyProofDocument {
  username: string;
  createdAt: number;
  publicKeyJwk: JsonWebKey;
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
  workerName?: string;
  workerVersion?: number;
  appHostname?: string;
  appHostHash?: string;
}

export interface PuterFedRoomsOptions {
  puter?: Pick<Puter, "auth" | "getUser" | "fs" | "workers" | "kv">;
  fetchFn?: typeof fetch;
  appBaseUrl?: string;
  identityProvider?: () => Promise<RoomUser>;
  deployWorker?: (args: DeployWorkerArgs) => Promise<string | void>;
}

export interface RoomSnapshot extends Room {
  members: string[];
  parentRooms: string[];
}
