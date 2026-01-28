export type ConversationType = "dm" | "group";

export type ConversationConfig = {
  id: string;
  type: ConversationType;
  participants: Participant[];
  groupSecret?: string;
  admins?: string[];
};

export type Participant = {
  id: string;
  signingPublicKeyPem: string;
  dhPublicKeyPem: string;
};

export type Identity = {
  id: string;
  signingPublicKeyPem: string;
  signingPrivateKeyPem: string;
  dhPublicKeyPem: string;
  dhPrivateKeyPem: string;
  createdAt: string;
};

export type EncryptedPayload = {
  alg: "AES-256-GCM";
  iv: string;
  ciphertext: string;
  tag: string;
  aad: string;
};

export type Envelope = {
  v: 1;
  type: "chat" | "revoke";
  conversationId: string;
  senderId: string;
  senderSigningPublicKeyPem: string;
  senderDhPublicKeyPem: string;
  timestamp: string;
  body: EncryptedPayload;
  signature: string;
};

export type DecryptedPayload =
  | {
      type: "chat";
      text: string;
      messageId?: string;
    }
  | {
      type: "revoke";
      targetMessageId: string;
      messageId?: string;
      asAdmin?: boolean; // 标识管理员撤回他人消息
    };

export type MessageRecord = {
  id: string;
  conversationId: string;
  senderId: string;
  text?: string;
  type: "chat" | "revoke";
  timestamp: string;
  status: "sent" | "received" | "revoked" | "deleted";
};

export type MessageHandler = (message: MessageRecord) => void;

export type TransportMessage = {
  payload: Uint8Array;
  contentTopic: string;
  pubsubTopic: string;
  timestamp: Date;
  messageId: string;
};

export type Transport = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  send: (contentTopic: string, payload: Uint8Array) => Promise<string>;
  subscribe: (
    contentTopic: string,
    handler: (message: TransportMessage) => void,
  ) => Promise<() => Promise<void>>;
};
