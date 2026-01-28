import crypto from "node:crypto";
import type { Identity } from "./types.js";

const HKDF_INFO = "waku-mini-chat";

export const generateIdentity = (): Identity => {
  const signing = crypto.generateKeyPairSync("ed25519");
  const dh = crypto.generateKeyPairSync("x25519");

  const signingPublicKeyPem = signing.publicKey.export({
    format: "pem",
    type: "spki",
  }) as string;
  const signingPrivateKeyPem = signing.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  const dhPublicKeyPem = dh.publicKey.export({
    format: "pem",
    type: "spki",
  }) as string;
  const dhPrivateKeyPem = dh.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;

  const id = crypto
    .createHash("sha256")
    .update(signingPublicKeyPem)
    .digest("hex");

  return {
    id,
    signingPublicKeyPem,
    signingPrivateKeyPem,
    dhPublicKeyPem,
    dhPrivateKeyPem,
    createdAt: new Date().toISOString(),
  };
};

export const importPrivateKey = (pem: string) =>
  crypto.createPrivateKey({ key: pem, format: "pem" });

export const importPublicKey = (pem: string) =>
  crypto.createPublicKey({ key: pem, format: "pem" });

export const signPayload = (payload: string, identity: Identity): string => {
  const signature = crypto.sign(
    null,
    Buffer.from(payload, "utf8"),
    importPrivateKey(identity.signingPrivateKeyPem),
  );
  return signature.toString("base64");
};

export const verifySignature = (
  payload: string,
  signatureBase64: string,
  publicKeyPem: string,
): boolean => {
  return crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    importPublicKey(publicKeyPem),
    Buffer.from(signatureBase64, "base64"),
  );
};

export const deriveSharedKey = (
  identity: Identity,
  peerDhPublicKeyPem: string,
  salt: string,
): Buffer => {
  const secret = crypto.diffieHellman({
    privateKey: importPrivateKey(identity.dhPrivateKeyPem),
    publicKey: importPublicKey(peerDhPublicKeyPem),
  });
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      secret,
      Buffer.from(salt, "utf8"),
      Buffer.from(HKDF_INFO, "utf8"),
      32,
    ),
  );
};

export const deriveGroupKey = (groupSecret: string, salt: string): Buffer => {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(groupSecret, "utf8"),
      Buffer.from(salt, "utf8"),
      Buffer.from(HKDF_INFO, "utf8"),
      32,
    ),
  );
};

export const encryptPayload = (
  plaintext: string,
  key: Buffer,
  aad: string,
) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    alg: "AES-256-GCM" as const,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    aad: Buffer.from(aad, "utf8").toString("base64"),
  };
};

export const decryptPayload = (
  encrypted: {
    iv: string;
    ciphertext: string;
    tag: string;
    aad: string;
  },
  key: Buffer,
): string => {
  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const aad = Buffer.from(encrypted.aad, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
};
