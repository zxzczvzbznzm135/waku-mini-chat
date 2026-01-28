import fs from "node:fs";
import path from "node:path";
import type { ConversationConfig, Identity, MessageRecord } from "./types.js";
import { generateIdentity } from "./crypto.js";

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const readJson = <T>(filePath: string, fallback: T): T => {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const writeJson = (filePath: string, value: unknown) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

export const loadOrCreateIdentity = (filePath: string): Identity => {
  if (fs.existsSync(filePath)) {
    return readJson<Identity>(filePath, generateIdentity());
  }
  const identity = generateIdentity();
  writeJson(filePath, identity);
  return identity;
};

export const loadConversations = (filePath: string): ConversationConfig[] =>
  readJson<ConversationConfig[]>(filePath, []);

export const saveConversations = (
  filePath: string,
  conversations: ConversationConfig[],
) => {
  writeJson(filePath, conversations);
};

export const loadMessages = (filePath: string): MessageRecord[] =>
  readJson<MessageRecord[]>(filePath, []);

export const saveMessages = (filePath: string, messages: MessageRecord[]) => {
  writeJson(filePath, messages);
};
