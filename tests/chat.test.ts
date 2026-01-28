import { describe, it, expect } from "vitest";
import { ChatClient } from "../src/sdk/chat.js";
import { MemoryTransport } from "../src/transports/memoryTransport.js";
import { generateIdentity } from "../src/sdk/crypto.js";
import type { ConversationConfig } from "../src/sdk/types.js";

const makeDmConversation = (
  a: ReturnType<typeof generateIdentity>,
  b: ReturnType<typeof generateIdentity>,
): ConversationConfig => ({
  id: `dm:${[a.id, b.id].sort().join(":")}`,
  type: "dm",
  participants: [
    {
      id: a.id,
      signingPublicKeyPem: a.signingPublicKeyPem,
      dhPublicKeyPem: a.dhPublicKeyPem,
    },
    {
      id: b.id,
      signingPublicKeyPem: b.signingPublicKeyPem,
      dhPublicKeyPem: b.dhPublicKeyPem,
    },
  ],
});

const makeGroupConversation = (
  id: string,
  secret: string,
  identities: ReturnType<typeof generateIdentity>[],
): ConversationConfig => ({
  id,
  type: "group",
  groupSecret: secret,
  participants: identities.map((identity) => ({
    id: identity.id,
    signingPublicKeyPem: identity.signingPublicKeyPem,
    dhPublicKeyPem: identity.dhPublicKeyPem,
  })),
});

describe("ChatClient", () => {
  it("单聊互发", async () => {
    const transport = new MemoryTransport();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const conversation = makeDmConversation(alice, bob);

    const aliceClient = new ChatClient(transport, alice);
    const bobClient = new ChatClient(transport, bob);
    aliceClient.joinConversation(conversation);
    bobClient.joinConversation(conversation);

    await aliceClient.start();
    await bobClient.start();

    let received = "";
    await bobClient.subscribe(conversation.id, (message) => {
      if (message.text) {
        received = message.text;
      }
    });

    await aliceClient.sendMessage(conversation.id, "hello");
    expect(received).toBe("hello");

    await aliceClient.stop();
    await bobClient.stop();
  });

  it("群聊广播", async () => {
    const transport = new MemoryTransport();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const carol = generateIdentity();
    const conversation = makeGroupConversation("group-1", "secret", [
      alice,
      bob,
      carol,
    ]);

    const aliceClient = new ChatClient(transport, alice);
    const bobClient = new ChatClient(transport, bob);
    const carolClient = new ChatClient(transport, carol);
    [aliceClient, bobClient, carolClient].forEach((client) =>
      client.joinConversation(conversation),
    );

    await aliceClient.start();
    await bobClient.start();
    await carolClient.start();

    let bobReceived = "";
    let carolReceived = "";
    await bobClient.subscribe(conversation.id, (message) => {
      if (message.text) bobReceived = message.text;
    });
    await carolClient.subscribe(conversation.id, (message) => {
      if (message.text) carolReceived = message.text;
    });

    await aliceClient.sendMessage(conversation.id, "group-hello");
    expect(bobReceived).toBe("group-hello");
    expect(carolReceived).toBe("group-hello");

    await aliceClient.stop();
    await bobClient.stop();
    await carolClient.stop();
  });

  it("撤回后各端一致显示", async () => {
    const transport = new MemoryTransport();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const conversation = makeDmConversation(alice, bob);

    const aliceClient = new ChatClient(transport, alice);
    const bobClient = new ChatClient(transport, bob);
    aliceClient.joinConversation(conversation);
    bobClient.joinConversation(conversation);

    await aliceClient.start();
    await bobClient.start();

    let targetId = "";
    await bobClient.subscribe(conversation.id, (message) => {
      if (message.type === "chat" && message.text) {
        targetId = message.id;
      }
    });

    await aliceClient.sendMessage(conversation.id, "to-revoke");
    expect(targetId).not.toBe("");

    await aliceClient.revokeMessage(conversation.id, targetId);
    const revoked = bobClient.listMessages().find((m) => m.id === targetId);
    expect(revoked?.status).toBe("revoked");

    await aliceClient.stop();
    await bobClient.stop();
  });
});
