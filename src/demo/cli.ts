import path from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import { ChatClient } from "../sdk/chat.js";
import type {
  ConversationConfig,
  Identity,
  MessageRecord,
  Participant,
} from "../sdk/types.js";
import {
  loadConversations,
  loadMessages,
  loadOrCreateIdentity,
  saveConversations,
  saveMessages,
} from "../sdk/storage.js";
import { WakuTransport } from "../transports/wakuTransport.js";

const program = new Command();

const resolveDataDir = (dir?: string) => {
  const base = dir ?? process.env.WMC_DATA_DIR ?? path.join(process.cwd(), ".wmc");
  return base;
};

const getPaths = (dataDir: string) => ({
  identity: path.join(dataDir, "identity.json"),
  conversations: path.join(dataDir, "conversations.json"),
  messages: path.join(dataDir, "messages.json"),
});

const loadIdentity = (dataDir: string) =>
  loadOrCreateIdentity(getPaths(dataDir).identity);

const loadConversationStore = (dataDir: string) => {
  const { conversations } = getPaths(dataDir);
  return {
    list: () => loadConversations(conversations),
    save: (items: ConversationConfig[]) => saveConversations(conversations, items),
  };
};

const loadMessageStore = (dataDir: string) => {
  const { messages } = getPaths(dataDir);
  return {
    list: () => loadMessages(messages),
    save: (items: MessageRecord[]) => saveMessages(messages, items),
  };
};

const createClient = async (dataDir: string, options?: {
  defaultBootstrap?: boolean;
  bootstrapPeers?: string[];
}) => {
  const identity = loadIdentity(dataDir);
  const transport = new WakuTransport({
    defaultBootstrap: options?.defaultBootstrap ?? false,
    bootstrapPeers: options?.bootstrapPeers ?? [],
  });
  const client = new ChatClient(transport, identity);
  const conversations = loadConversationStore(dataDir).list();
  client.initConversations(conversations);
  const messages = loadMessageStore(dataDir).list();
  messages.forEach((message) => client.upsertMessage(message));
  await client.start();
  return { client, transport, identity, conversations };
};

program
  .name("waku-mini-chat")
  .description("Minimal Waku chat demo")
  .option("--data-dir <dir>", "Data directory (identity/conversations/messages)");

program
  .command("init")
  .description("Initialize identity")
  .action(() => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const identity = loadIdentity(dataDir);
    console.log("identityPath:", getPaths(dataDir).identity);
    console.log("userId:", identity.id);
  });

program
  .command("export-identity")
  .description("Export public identity info")
  .option("--out <file>", "Output file path", "peer.json")
  .action((options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const identity = loadIdentity(dataDir);
    const publicInfo = {
      id: identity.id,
      signingPublicKeyPem: identity.signingPublicKeyPem,
      dhPublicKeyPem: identity.dhPublicKeyPem,
    };
    fs.writeFileSync(options.out, JSON.stringify(publicInfo, null, 2));
    console.log("written:", options.out);
  });

program
  .command("create-dm")
  .description("Create/join a DM conversation")
  .requiredOption("--peer <file>", "Peer public JSON file")
  .action((options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const identity = loadIdentity(dataDir);
    const peer = JSON.parse(fs.readFileSync(options.peer, "utf8")) as Participant;
    const ids = [identity.id, peer.id].sort();
    const conversationId = `dm:${ids[0]}:${ids[1]}`;
    const conversation: ConversationConfig = {
      id: conversationId,
      type: "dm",
      participants: [
        {
          id: identity.id,
          signingPublicKeyPem: identity.signingPublicKeyPem,
          dhPublicKeyPem: identity.dhPublicKeyPem,
        },
        peer,
      ],
    };
    const store = loadConversationStore(dataDir);
    const list = store.list();
    const next = [...list.filter((item) => item.id !== conversationId), conversation];
    store.save(next);
    console.log("conversationId:", conversationId);
  });

program
  .command("join-group")
  .description("Join a group conversation")
  .requiredOption("--id <id>", "Group ID")
  .requiredOption("--secret <secret>", "Group shared secret")
  .action((options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const identity = loadIdentity(dataDir);
    const conversation: ConversationConfig = {
      id: options.id,
      type: "group",
      groupSecret: options.secret,
      participants: [
        {
          id: identity.id,
          signingPublicKeyPem: identity.signingPublicKeyPem,
          dhPublicKeyPem: identity.dhPublicKeyPem,
        },
      ],
    };
    const store = loadConversationStore(dataDir);
    const list = store.list();
    const next = [...list.filter((item) => item.id !== options.id), conversation];
    store.save(next);
    console.log("joined:", options.id);
  });

program
  .command("send")
  .description("Send a message")
  .requiredOption("--conversation <id>", "Conversation ID")
  .requiredOption("--text <text>", "Message text")
  .option("--bootstrap <addr...>", "Waku bootstrap multiaddr")
  .option("--public", "Use default bootstrap")
  .action(async (options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const store = loadMessageStore(dataDir);
    const { client } = await createClient(dataDir, {
      defaultBootstrap: options.public ?? false,
      bootstrapPeers: options.bootstrap ?? [],
    });
    const messageId = await client.sendMessage(options.conversation, options.text);
    const record: MessageRecord = {
      id: messageId,
      conversationId: options.conversation,
      senderId: client.getIdentity().id,
      text: options.text,
      type: "chat",
      timestamp: new Date().toISOString(),
      status: "sent",
    };
    client.upsertMessage(record);
    store.save(client.listMessages());
    console.log("messageId:", messageId);
    await client.stop();
  });

program
  .command("revoke")
  .description("Revoke a message")
  .requiredOption("--conversation <id>", "Conversation ID")
  .requiredOption("--message-id <id>", "Target message ID")
  .option("--bootstrap <addr...>", "Waku bootstrap multiaddr")
  .option("--public", "Use default bootstrap")
  .action(async (options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const store = loadMessageStore(dataDir);
    const { client } = await createClient(dataDir, {
      defaultBootstrap: options.public ?? false,
      bootstrapPeers: options.bootstrap ?? [],
    });
    const revokeId = await client.revokeMessage(
      options.conversation,
      options.messageId,
    );
    const current = client.listMessages().map((message) =>
      message.id === options.messageId
        ? { ...message, status: "revoked" as const }
        : message,
    );
    store.save(current);
    console.log("revokeMessageId:", revokeId);
    await client.stop();
  });

program
  .command("delete")
  .description("Delete a message locally")
  .requiredOption("--message-id <id>", "Target message ID")
  .action((options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const store = loadMessageStore(dataDir);
    const messages = store.list().map((message) =>
      message.id === options.messageId
        ? { ...message, status: "deleted" as const }
        : message,
    );
    store.save(messages);
    console.log("deleted:", options.messageId);
  });

program
  .command("listen")
  .description("Listen for conversation messages")
  .requiredOption("--conversation <id>", "Conversation ID")
  .option("--bootstrap <addr...>", "Waku bootstrap multiaddr")
  .option("--public", "Use default bootstrap")
  .action(async (options) => {
    const dataDir = resolveDataDir(program.opts().dataDir);
    const store = loadMessageStore(dataDir);
    const { client } = await createClient(dataDir, {
      defaultBootstrap: options.public ?? false,
      bootstrapPeers: options.bootstrap ?? [],
    });
    await client.subscribe(options.conversation, (message) => {
      client.upsertMessage(message);
      store.save(client.listMessages());
      if (message.status === "revoked") {
        console.log(`[revoked] ${message.id}`);
        return;
      }
      if (message.status === "deleted") {
        console.log(`[deleted] ${message.id}`);
        return;
      }
      if (message.type === "revoke") {
        console.log(`[tombstone] ${message.id}`);
        return;
      }
      console.log(
        `[${message.timestamp}] ${message.senderId.slice(0, 8)}: ${message.text}`,
      );
    });
    console.log("listening...");
  });

program.parse();
