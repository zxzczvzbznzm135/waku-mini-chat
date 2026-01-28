import {
  decryptPayload,
  deriveGroupKey,
  deriveSharedKey,
  encryptPayload,
  signPayload,
  verifySignature,
} from "./crypto.js";
import { contentTopicForConversation } from "./topics.js";
import type {
  ConversationConfig,
  DecryptedPayload,
  Envelope,
  Identity,
  MessageHandler,
  MessageRecord,
  Transport,
} from "./types.js";

const buildSignablePayload = (envelope: Omit<Envelope, "signature">) =>
  JSON.stringify(envelope);

const buildMessageRecord = (
  id: string,
  envelope: Envelope,
  payload: DecryptedPayload,
  status: MessageRecord["status"],
): MessageRecord => ({
  id,
  conversationId: envelope.conversationId,
  senderId: envelope.senderId,
  text: payload.type === "chat" ? payload.text : undefined,
  type: envelope.type,
  timestamp: envelope.timestamp,
  status,
});

export class ChatClient {
  private transport: Transport;
  private identity: Identity;
  private conversations = new Map<string, ConversationConfig>();
  private messages = new Map<string, MessageRecord>();
  private pendingRevokes = new Map<string, { envelope: Envelope; asAdmin?: boolean }>();

  constructor(transport: Transport, identity: Identity) {
    this.transport = transport;
    this.identity = identity;
  }

  getIdentity(): Identity {
    return this.identity;
  }

  listMessages(): MessageRecord[] {
    return Array.from(this.messages.values());
  }

  upsertMessage(record: MessageRecord) {
    this.messages.set(record.id, record);
  }

  initConversations(conversations: ConversationConfig[]) {
    conversations.forEach((conv) => this.conversations.set(conv.id, conv));
  }

  listConversations(): ConversationConfig[] {
    return Array.from(this.conversations.values());
  }

  joinConversation(config: ConversationConfig) {
    this.conversations.set(config.id, config);
  }

  leaveConversation(conversationId: string) {
    this.conversations.delete(conversationId);
  }

  async start() {
    await this.transport.start();
  }

  async stop() {
    await this.transport.stop();
  }

  async sendMessage(conversationId: string, text: string): Promise<string> {
    const conversation = this.requireConversation(conversationId);
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const payload: DecryptedPayload = { type: "chat", text, messageId };
    const envelope = await this.buildEnvelope(conversation, payload);
    const raw = JSON.stringify(envelope);
    await this.transport.send(
      contentTopicForConversation(conversationId),
      Buffer.from(raw, "utf8"),
    );
    return messageId;
  }

  async revokeMessage(
    conversationId: string,
    targetMessageId: string,
  ): Promise<string> {
    const conversation = this.requireConversation(conversationId);
    const target = this.messages.get(targetMessageId);
    
    // 检查撤回权限：原发送者或管理员可以撤回
    const isAdmin = conversation.admins?.includes(this.identity.id) ?? false;
    const isOwner = target?.senderId === this.identity.id;
    
    const revokeId = `revoke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const payload: DecryptedPayload = {
      type: "revoke",
      targetMessageId,
      messageId: revokeId,
      asAdmin: !isOwner && isAdmin,
    };
    const envelope = await this.buildEnvelope(conversation, payload, "revoke");
    const raw = JSON.stringify(envelope);
    await this.transport.send(
      contentTopicForConversation(conversationId),
      Buffer.from(raw, "utf8"),
    );
    return revokeId;
  }

  deleteLocalMessage(messageId: string) {
    const record = this.messages.get(messageId);
    if (!record) return;
    this.messages.set(messageId, { ...record, status: "deleted" });
  }

  async subscribe(conversationId: string, handler: MessageHandler) {
    const conversation = this.requireConversation(conversationId);
    const contentTopic = contentTopicForConversation(conversationId);
    return this.transport.subscribe(contentTopic, (transportMessage) => {
      const decoded = this.parseEnvelope(transportMessage.payload);
      if (!decoded) return;
      if (!this.verifyEnvelope(decoded)) return;

      const payload = this.decryptEnvelope(conversation, decoded);
      if (!payload) return;

      // 使用 payload 中的 messageId，保证一致性
      const messageId = payload.messageId || transportMessage.messageId;

      // 处理撤回消息
      if (payload.type === "revoke") {
        const revoked = this.applyRevoke(decoded, payload.targetMessageId, payload.asAdmin);
        const record = buildMessageRecord(
          messageId,
          decoded,
          payload,
          "received",
        );
        handler({
          ...record,
          text: undefined,
          status: "received",
        });
        if (revoked) {
          handler(revoked);
        }
        return;
      }

      const record = buildMessageRecord(
        messageId,
        decoded,
        payload,
        decoded.senderId === this.identity.id ? "sent" : "received",
      );

      this.upsertMessage(record);
      this.applyPendingRevoke(record.id);
      handler(record);
    });
  }

  private applyPendingRevoke(messageId: string) {
    const pending = this.pendingRevokes.get(messageId);
    if (!pending) return;
    this.applyRevoke(pending.envelope, messageId, pending.asAdmin);
    this.pendingRevokes.delete(messageId);
  }

  private applyRevoke(
    envelope: Envelope,
    targetMessageId: string,
    asAdmin?: boolean,
  ): MessageRecord | null {
    const target = this.messages.get(targetMessageId);
    if (!target) {
      this.pendingRevokes.set(targetMessageId, { envelope, asAdmin });
      return null;
    }
    
    // 检查撤回权限：
    // 1. 原发送者可以撤回自己的消息
    // 2. 消息中标记 asAdmin=true 的管理员撤回（消息已签名验证，信任来源）
    // 3. 本地配置的管理员也可以撤回
    const conversation = this.conversations.get(target.conversationId);
    const localIsAdmin = conversation?.admins?.includes(envelope.senderId) ?? false;
    const isOwner = target.senderId === envelope.senderId;
    
    if (!isOwner && !asAdmin && !localIsAdmin) {
      return null;
    }
    
    const updated = { ...target, status: "revoked" } as MessageRecord;
    this.messages.set(targetMessageId, updated);
    return updated;
  }
  
  isAdmin(conversationId: string): boolean {
    const conversation = this.conversations.get(conversationId);
    return conversation?.admins?.includes(this.identity.id) ?? false;
  }

  private requireConversation(conversationId: string): ConversationConfig {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  private async buildEnvelope(
    conversation: ConversationConfig,
    payload: DecryptedPayload,
    overrideType?: Envelope["type"],
  ): Promise<Envelope> {
    const key = this.deriveKey(conversation);
    const aad = `${conversation.id}:${this.identity.id}:${Date.now()}`;
    const encrypted = encryptPayload(JSON.stringify(payload), key, aad);
    const envelope: Omit<Envelope, "signature"> = {
      v: 1,
      type: overrideType ?? payload.type,
      conversationId: conversation.id,
      senderId: this.identity.id,
      senderSigningPublicKeyPem: this.identity.signingPublicKeyPem,
      senderDhPublicKeyPem: this.identity.dhPublicKeyPem,
      timestamp: new Date().toISOString(),
      body: encrypted,
    };
    const signature = signPayload(buildSignablePayload(envelope), this.identity);
    return { ...envelope, signature };
  }

  private parseEnvelope(payload: Uint8Array): Envelope | null {
    try {
      const raw = Buffer.from(payload).toString("utf8");
      const envelope = JSON.parse(raw) as Envelope;
      if (envelope?.v !== 1) return null;
      return envelope;
    } catch (error) {
      return null;
    }
  }

  private verifyEnvelope(envelope: Envelope): boolean {
    const { signature, ...rest } = envelope;
    return verifySignature(
      buildSignablePayload(rest),
      signature,
      envelope.senderSigningPublicKeyPem,
    );
  }

  private decryptEnvelope(
    conversation: ConversationConfig,
    envelope: Envelope,
  ): DecryptedPayload | null {
    try {
      const key = this.deriveKey(conversation, envelope);
      const raw = decryptPayload(envelope.body, key);
      return JSON.parse(raw) as DecryptedPayload;
    } catch (error) {
      return null;
    }
  }

  private deriveKey(
    conversation: ConversationConfig,
    envelope?: Envelope,
  ): Buffer {
    if (conversation.type === "group") {
      if (!conversation.groupSecret) {
        throw new Error("Group conversation missing groupSecret");
      }
      return deriveGroupKey(conversation.groupSecret, conversation.id);
    }

    const participants = conversation.participants;
    const peer = participants.find((p) => p.id !== this.identity.id);
    const senderIsSelf = envelope?.senderId === this.identity.id;
    const peerDh = senderIsSelf
      ? peer?.dhPublicKeyPem
      : envelope?.senderDhPublicKeyPem ?? peer?.dhPublicKeyPem;
    if (!peerDh) {
      throw new Error("DM conversation missing peer DH public key");
    }
    return deriveSharedKey(this.identity, peerDh, conversation.id);
  }
}
