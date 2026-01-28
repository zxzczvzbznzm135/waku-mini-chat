import {
  Protocols,
  createLightNode,
  type LightNode,
  waku,
} from "@waku/sdk";
import type { Transport, TransportMessage } from "../sdk/types.js";

export type WakuTransportConfig = {
  defaultBootstrap?: boolean;
  bootstrapPeers?: string[];
  waitForPeersTimeoutMs?: number;
};

export class WakuTransport implements Transport {
  private node: LightNode | null = null;
  private config: WakuTransportConfig;

  constructor(config: WakuTransportConfig = {}) {
    this.config = config;
  }

  async start() {
    if (this.node) return;
    this.node = await createLightNode({
      defaultBootstrap: this.config.defaultBootstrap ?? false,
    });
    await this.node.start();

    if (this.config.bootstrapPeers?.length) {
      for (const peer of this.config.bootstrapPeers) {
        await this.node.dial(peer);
      }
    }

    await this.node.waitForPeers(
      [Protocols.LightPush, Protocols.Filter],
      this.config.waitForPeersTimeoutMs ?? 10_000,
    );
  }

  async stop() {
    if (!this.node) return;
    await this.node.stop();
    this.node = null;
  }

  async send(contentTopic: string, payload: Uint8Array): Promise<string> {
    if (!this.node) throw new Error("Waku node not started");
    const encoder = this.node.createEncoder({ contentTopic });
    const message = { payload, timestamp: new Date() };
    const proto = await encoder.toProtoObj(message);
    const messageId = waku.messageHashStr(encoder.pubsubTopic, proto);
    await this.node.lightPush.send(encoder, message);
    return messageId;
  }

  async subscribe(
    contentTopic: string,
    handler: (message: TransportMessage) => void,
  ): Promise<() => Promise<void>> {
    if (!this.node) throw new Error("Waku node not started");
    const decoder = this.node.createDecoder({ contentTopic });
    const filter = this.node.filter as unknown as {
      subscribe: (dec: unknown, cb: (decoded: any) => void) => Promise<unknown>;
      unsubscribe?: (dec: unknown) => Promise<unknown>;
      unsubscribeAll?: () => Promise<unknown>;
    };
    await filter.subscribe(decoder, (decoded) => {
      const messageId = decoded.hashStr;
      handler({
        payload: decoded.payload,
        contentTopic: decoded.contentTopic,
        pubsubTopic: decoded.pubsubTopic,
        timestamp: decoded.timestamp ?? new Date(),
        messageId,
      });
    });

    return async () => {
      if (filter.unsubscribe) {
        await filter.unsubscribe(decoder);
        return;
      }
      if (filter.unsubscribeAll) {
        await filter.unsubscribeAll();
      }
    };
  }
}
