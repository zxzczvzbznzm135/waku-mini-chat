import {
  decryptPayload,
  deriveGroupKey,
  deriveSharedKey,
  encryptPayload,
  signPayload,
  verifySignature,
} from "./crypto";
import type {
  ConversationConfig,
  DecryptedPayload,
  Envelope,
  Identity,
  MessageHandler,
  MessageRecord,
} from "../sdk/types";

const contentTopicForConversation = (conversationId: string) =>
  `/waku-mini-chat/1/${conversationId}/json`;

const buildSignablePayload = (envelope: Omit<Envelope, "signature">) =>
  JSON.stringify(envelope);

const buildMessageRecord = (
  id: string,
  envelope: Envelope,
  payload: DecryptedPayload,
  status: MessageRecord["status"]
): MessageRecord => ({
  id,
  conversationId: envelope.conversationId,
  senderId: envelope.senderId,
  text: payload.type === "chat" ? payload.text : undefined,
  type: envelope.type,
  timestamp: envelope.timestamp,
  status,
});

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export class BrowserChatClient {
  private node: any = null;
  private identity: Identity;
  private conversations = new Map<string, ConversationConfig>();
  private messages = new Map<string, MessageRecord>();
  private pendingRevokes = new Map<string, { envelope: Envelope; asAdmin?: boolean }>();
  private subscriptions = new Map<string, () => Promise<void>>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private _status: ConnectionStatus = "disconnected";

  constructor(identity: Identity) {
    this.identity = identity;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  onStatusChange(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getIdentity(): Identity {
    return this.identity;
  }

  listMessages(): MessageRecord[] {
    return Array.from(this.messages.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  getMessagesForConversation(conversationId: string): MessageRecord[] {
    return this.listMessages().filter(
      (m) => m.conversationId === conversationId && m.status !== "deleted"
    );
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
    // 同时清除该会话的所有消息
    for (const [id, msg] of this.messages) {
      if (msg.conversationId === conversationId) {
        this.messages.delete(id);
      }
    }
    // 取消订阅
    const unsub = this.subscriptions.get(conversationId);
    if (unsub) {
      unsub();
      this.subscriptions.delete(conversationId);
    }
  }

  async start(options?: { defaultBootstrap?: boolean; bootstrapPeers?: string[] }) {
    if (this.node) return;

    this.setStatus("connecting");

    try {
      const { createLightNode, Protocols } = await import("@waku/sdk");

      this.node = await createLightNode({
        defaultBootstrap: options?.defaultBootstrap ?? true,
      });

      await this.node.start();

      if (options?.bootstrapPeers?.length) {
        for (const peer of options.bootstrapPeers) {
          try {
            await this.node.dial(peer);
          } catch (e) {
            console.warn("Failed to dial peer:", peer, e);
          }
        }
      }

      await this.node.waitForPeers([Protocols.LightPush, Protocols.Filter], 30000);
      this.setStatus("connected");
    } catch (error) {
      this.setStatus("disconnected");
      throw error;
    }
  }

  async stop() {
    for (const unsub of this.subscriptions.values()) {
      await unsub();
    }
    this.subscriptions.clear();

    if (this.node) {
      await this.node.stop();
      this.node = null;
    }
    this.setStatus("disconnected");
  }

  async sendMessage(conversationId: string, text: string): Promise<string> {
    const conversation = this.requireConversation(conversationId);
    // 生成唯一的消息 ID，嵌入到 payload 中
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const payload: DecryptedPayload = { type: "chat", text, messageId };
    const envelope = await this.buildEnvelope(conversation, payload);
    const raw = JSON.stringify(envelope);
    const encoder = this.node.createEncoder({
      contentTopic: contentTopicForConversation(conversationId),
    });
    const message = { payload: new TextEncoder().encode(raw), timestamp: new Date() };
    await this.node.lightPush.send(encoder, message);

    // 本地立即存储消息
    const record: MessageRecord = {
      id: messageId,
      conversationId,
      senderId: this.identity.id,
      text,
      type: "chat",
      timestamp: envelope.timestamp,
      status: "sent",
    };
    this.upsertMessage(record);

    return messageId;
  }

  async revokeMessage(conversationId: string, targetMessageId: string): Promise<string> {
    const conversation = this.requireConversation(conversationId);
    const target = this.messages.get(targetMessageId);
    
    // 检查撤回权限：原发送者或管理员可以撤回
    const isAdmin = conversation.admins?.includes(this.identity.id) ?? false;
    const isOwner = target?.senderId === this.identity.id;
    if (!isOwner && !isAdmin) {
      throw new Error("没有权限撤回此消息");
    }
    
    const revokeId = `revoke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    // 如果是管理员撤回他人消息，标记 asAdmin
    const payload: DecryptedPayload = { 
      type: "revoke", 
      targetMessageId, 
      messageId: revokeId,
      asAdmin: !isOwner && isAdmin,
    };
    const envelope = await this.buildEnvelope(conversation, payload, "revoke");
    const raw = JSON.stringify(envelope);
    const encoder = this.node.createEncoder({
      contentTopic: contentTopicForConversation(conversationId),
    });
    const message = { payload: new TextEncoder().encode(raw), timestamp: new Date() };
    await this.node.lightPush.send(encoder, message);

    // 立即本地标记为已撤回
    if (target) {
      this.messages.set(targetMessageId, { ...target, status: "revoked" });
    }

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

    if (this.subscriptions.has(conversationId)) {
      return;
    }

    const decoder = this.node.createDecoder({ contentTopic });

    const filter = this.node.filter as any;
    await filter.subscribe(decoder, async (decoded: any) => {
      try {
        const payloadBytes = decoded.payload;
        const raw = new TextDecoder().decode(payloadBytes);
        const envelope = JSON.parse(raw) as Envelope;

        if (envelope?.v !== 1) return;
        if (!(await this.verifyEnvelope(envelope))) return;

        const decrypted = await this.decryptEnvelope(conversation, envelope);
        if (!decrypted) return;

        // 使用 payload 中的 messageId，保证发送方和接收方一致
        const messageId = decrypted.messageId || decoded.hashStr || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // 处理撤回消息
        if (decrypted.type === "revoke") {
          const revoked = this.applyRevoke(envelope, decrypted.targetMessageId, decrypted.asAdmin);
          if (revoked) {
            handler(revoked);
          }
          return;
        }

        // 如果是自己发送的消息，跳过（已经在 sendMessage 中存储）
        if (envelope.senderId === this.identity.id) {
          return;
        }

        const record = buildMessageRecord(
          messageId,
          envelope,
          decrypted,
          "received"
        );

        this.upsertMessage(record);
        this.applyPendingRevoke(record.id);
        handler(record);
      } catch (e) {
        console.error("Error processing message:", e);
      }
    });

    this.subscriptions.set(conversationId, async () => {
      // Unsubscribe logic would go here
    });
  }

  private applyPendingRevoke(messageId: string) {
    const pending = this.pendingRevokes.get(messageId);
    if (!pending) return;
    this.applyRevoke(pending.envelope, messageId, pending.asAdmin);
    this.pendingRevokes.delete(messageId);
  }

  private applyRevoke(envelope: Envelope, targetMessageId: string, asAdmin?: boolean): MessageRecord | null {
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
  
  // 检查当前用户是否是指定会话的管理员
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
    overrideType?: Envelope["type"]
  ): Promise<Envelope> {
    const key = await this.deriveKey(conversation);
    const aad = `${conversation.id}:${this.identity.id}:${Date.now()}`;
    const encrypted = await encryptPayload(JSON.stringify(payload), key, aad);
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
    const signature = await signPayload(buildSignablePayload(envelope), this.identity);
    return { ...envelope, signature };
  }

  private async verifyEnvelope(envelope: Envelope): Promise<boolean> {
    const { signature, ...rest } = envelope;
    return verifySignature(
      buildSignablePayload(rest),
      signature,
      envelope.senderSigningPublicKeyPem
    );
  }

  private async decryptEnvelope(
    conversation: ConversationConfig,
    envelope: Envelope
  ): Promise<DecryptedPayload | null> {
    try {
      const key = await this.deriveKey(conversation, envelope);
      const raw = await decryptPayload(envelope.body, key);
      return JSON.parse(raw) as DecryptedPayload;
    } catch {
      return null;
    }
  }

  private async deriveKey(
    conversation: ConversationConfig,
    envelope?: Envelope
  ): Promise<CryptoKey> {
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
