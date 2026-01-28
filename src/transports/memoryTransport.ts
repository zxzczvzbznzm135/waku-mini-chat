import { PUBSUB_TOPIC } from "../sdk/topics.js";
import type { Transport, TransportMessage } from "../sdk/types.js";
import crypto from "node:crypto";

type Handler = (message: TransportMessage) => void;

export class MemoryTransport implements Transport {
  private handlers = new Map<string, Set<Handler>>();

  async start() {
    return;
  }

  async stop() {
    this.handlers.clear();
  }

  async send(contentTopic: string, payload: Uint8Array): Promise<string> {
    const messageId = crypto
      .createHash("sha256")
      .update(payload)
      .digest("hex");
    const message: TransportMessage = {
      payload,
      contentTopic,
      pubsubTopic: PUBSUB_TOPIC,
      timestamp: new Date(),
      messageId,
    };
    const listeners = this.handlers.get(contentTopic);
    listeners?.forEach((handler) => handler(message));
    return messageId;
  }

  async subscribe(
    contentTopic: string,
    handler: (message: TransportMessage) => void,
  ): Promise<() => Promise<void>> {
    if (!this.handlers.has(contentTopic)) {
      this.handlers.set(contentTopic, new Set());
    }
    const set = this.handlers.get(contentTopic)!;
    set.add(handler);
    return async () => {
      set.delete(handler);
    };
  }
}
