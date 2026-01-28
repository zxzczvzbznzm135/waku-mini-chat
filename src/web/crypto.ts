// Browser-compatible crypto utilities using Web Crypto API
import type { Identity, EncryptedPayload } from "../sdk/types";

const HKDF_INFO = new TextEncoder().encode("waku-mini-chat");

export const generateIdentity = async (): Promise<Identity> => {
  // Generate signing key pair (ECDSA P-256 for browser compatibility)
  const signingKey = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  // Generate DH key pair (ECDH P-256)
  const dhKey = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );

  const signingPublicKeyPem = await exportPublicKey(signingKey.publicKey);
  const signingPrivateKeyPem = await exportPrivateKey(signingKey.privateKey);
  const dhPublicKeyPem = await exportPublicKey(dhKey.publicKey);
  const dhPrivateKeyPem = await exportPrivateKey(dhKey.privateKey);

  const id = await hashString(signingPublicKeyPem);

  return {
    id,
    signingPublicKeyPem,
    signingPrivateKeyPem,
    dhPublicKeyPem,
    dhPrivateKeyPem,
    createdAt: new Date().toISOString(),
  };
};

const exportPublicKey = async (key: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey("spki", key);
  return `-----BEGIN PUBLIC KEY-----\n${arrayBufferToBase64(exported)}\n-----END PUBLIC KEY-----`;
};

const exportPrivateKey = async (key: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey("pkcs8", key);
  return `-----BEGIN PRIVATE KEY-----\n${arrayBufferToBase64(exported)}\n-----END PRIVATE KEY-----`;
};

const importSigningPrivateKey = async (pem: string): Promise<CryptoKey> => {
  const binaryDer = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
};

const importSigningPublicKey = async (pem: string): Promise<CryptoKey> => {
  const binaryDer = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "spki",
    binaryDer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
};

const importDhPrivateKey = async (pem: string): Promise<CryptoKey> => {
  const binaryDer = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
};

const importDhPublicKey = async (pem: string): Promise<CryptoKey> => {
  const binaryDer = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "spki",
    binaryDer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
};

export const signPayload = async (
  payload: string,
  identity: Identity
): Promise<string> => {
  const privateKey = await importSigningPrivateKey(identity.signingPrivateKeyPem);
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    data
  );
  return arrayBufferToBase64(signature);
};

export const verifySignature = async (
  payload: string,
  signatureBase64: string,
  publicKeyPem: string
): Promise<boolean> => {
  try {
    const publicKey = await importSigningPublicKey(publicKeyPem);
    const data = new TextEncoder().encode(payload);
    const signature = base64ToArrayBuffer(signatureBase64);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      data
    );
  } catch {
    return false;
  }
};

export const deriveSharedKey = async (
  identity: Identity,
  peerDhPublicKeyPem: string,
  salt: string
): Promise<CryptoKey> => {
  const privateKey = await importDhPrivateKey(identity.dhPrivateKeyPem);
  const publicKey = await importDhPublicKey(peerDhPublicKeyPem);

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );

  const saltBuffer = new TextEncoder().encode(salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: saltBuffer, info: HKDF_INFO },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

export const deriveGroupKey = async (
  groupSecret: string,
  salt: string
): Promise<CryptoKey> => {
  const secretBuffer = new TextEncoder().encode(groupSecret);
  const saltBuffer = new TextEncoder().encode(salt);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secretBuffer,
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: saltBuffer, info: HKDF_INFO },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

export const encryptPayload = async (
  plaintext: string,
  key: CryptoKey,
  aad: string
): Promise<EncryptedPayload> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const aadBuffer = new TextEncoder().encode(aad);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadBuffer },
    key,
    data
  );

  return {
    alg: "AES-256-GCM",
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext),
    tag: "", // GCM tag is included in ciphertext in Web Crypto
    aad: arrayBufferToBase64(aadBuffer),
  };
};

export const decryptPayload = async (
  encrypted: EncryptedPayload,
  key: CryptoKey
): Promise<string> => {
  const iv = base64ToArrayBuffer(encrypted.iv);
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);
  const aad = base64ToArrayBuffer(encrypted.aad);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
};

// Utility functions
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const pemToArrayBuffer = (pem: string): ArrayBuffer => {
  const b64 = pem
    .replace(/-----BEGIN.*-----/, "")
    .replace(/-----END.*-----/, "")
    .replace(/\s/g, "");
  return base64ToArrayBuffer(b64);
};

const hashString = async (str: string): Promise<string> => {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
