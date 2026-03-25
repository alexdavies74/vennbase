const textEncoder = new TextEncoder();

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toBase64(input: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input).toString("base64");
  }

  let binary = "";
  input.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(input: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64"));
  }

  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const base64 = toBase64(toUint8Array(value));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return fromBase64(padded);
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const body = entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
    .join(",");
  return `{${body}}`;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value));
}

export async function hashCanonicalValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(canonicalBytes(value)));
  return toBase64Url(digest);
}

export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );
}

export async function exportPublicJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", publicKey);
}

export async function exportPrivateJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", privateKey);
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["verify"],
  );
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign"],
  );
}

export async function importP256KeyPair(jwkPair: {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}): Promise<CryptoKeyPair> {
  const [publicKey, privateKey] = await Promise.all([
    importPublicKey(jwkPair.publicKeyJwk),
    importPrivateKey(jwkPair.privateKeyJwk),
  ]);

  return {
    publicKey,
    privateKey,
  };
}

export async function signCanonicalValue(value: unknown, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    privateKey,
    toArrayBuffer(canonicalBytes(value)),
  );

  return toBase64Url(signature);
}

export async function verifyCanonicalValue(
  value: unknown,
  signatureBase64Url: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  return crypto.subtle.verify(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    publicKey,
    toArrayBuffer(fromBase64Url(signatureBase64Url)),
    toArrayBuffer(canonicalBytes(value)),
  );
}
