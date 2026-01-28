# 设计文档：Waku 迷你加密聊天封装

## 目标与范围
实现一个最小可用的 Chat SDK + CLI Demo，支持单聊、群聊、撤回与本地删除。核心基于 Waku 的消息发布/订阅与应用层加密。

## Topic 规划
- **pubsub topic（路由层）**：用于网络层路由与分片，影响消息在哪个 shard 上传播。
- **content topic（应用层标识）**：用于区分应用、版本、会话等，客户端按内容主题过滤消息。
- 选型：使用 SDK 默认的 pubsub 分片配置，应用层自定义 content topic。

本项目 content topic 规划：
```
/waku-mini-chat/1/{conversationId}/json
```
`conversationId` 对应单聊或群聊会话 ID。Waku 对 pubsub topic 与 content topic 的概念及用途说明可参考官方文档。[https://waku.gg](https://waku.gg)

## Relay vs LightPush/Filter
本实现默认采用 **LightPush + Filter**：
- 轻节点成本低，适合移动端与资源受限设备。
- 发送依赖 LightPush 服务端，接收依赖 Filter 服务端。
- 通过 `createLightNode` 与 `waitForPeers([Protocols.LightPush, Protocols.Filter])` 连接具备该协议的远端节点。

轻节点发送与过滤的概念参见 Waku JS 文档。[https://docs.waku.org/build/javascript/light-send-receive/](https://docs.waku.org/build/javascript/light-send-receive/)

## 消息唯一标识
消息 ID 采用 Waku 的 **message hash**（SHA-256，基于 pubsub topic + payload + content topic + meta + timestamp）。SDK 中可用 `messageHashStr` 生成。[https://js.waku.org/functions/_waku_sdk.waku.messageHashStr.html](https://js.waku.org/functions/_waku_sdk.waku.messageHashStr.html)

优势：
- 可追溯：同一消息在不同节点计算一致。
- 可验证：撤回消息引用同一个 messageId。

## 消息格式（JSON）
顶层 envelope（签名对象）：
```
{
  "v": 1,
  "type": "chat" | "revoke",
  "conversationId": "...",
  "senderId": "...",
  "senderSigningPublicKeyPem": "...",
  "senderDhPublicKeyPem": "...",
  "timestamp": "ISO-8601",
  "body": {
    "alg": "AES-256-GCM",
    "iv": "...",
    "ciphertext": "...",
    "tag": "...",
    "aad": "..."
  },
  "signature": "base64"
}
```

加密后的 payload（body 解密后）：
```
{ "type": "chat", "text": "..." }
{ "type": "revoke", "targetMessageId": "..." }
```

## 身份与密钥
- 身份：每个用户持久化一组 **Ed25519 签名密钥** + **X25519 密钥交换**（保存到本地文件）。
- 用户 ID：签名公钥的 SHA-256 hex。

## 机密性与完整性
**机密性**：应用层 AES-256-GCM 对 payload 加密。  
**完整性**：对 envelope（不含 signature 字段）进行 Ed25519 签名。

### 会话密钥
- 单聊：X25519 ECDH 共享秘密 → HKDF(sha256) → 会话密钥。
- 群聊：共享 `groupSecret` → HKDF(sha256) → 会话密钥。

## 撤回与删除
- **删除**：本地删除（仅本机隐藏），不影响其他端。
- **撤回**：发送 `type=revoke` 控制消息，包含被撤回的 `targetMessageId`。
- **鉴权**：撤回消息必须由原消息发送者签名。客户端验证签名并比对原消息 `senderId`。

### 现实边界
去中心化网络无法强制所有节点删除已传播的消息。撤回仅通过控制消息让客户端执行“逻辑隐藏/替换”，并不能保证所有节点真正删除。此限制属于分布式系统中的事实边界。

## 权限模型：群管理员

### 设计说明
群聊支持管理员角色，管理员可以撤回群内**任意成员**的消息（包括他人消息）。

### 数据结构
`ConversationConfig` 中的 `admins` 字段：
```typescript
{
  id: string;
  type: "group";
  groupSecret: string;
  admins?: string[];  // 管理员用户 ID 列表
  participants: Participant[];
}
```

### 撤回消息格式
管理员撤回他人消息时，在加密 payload 中包含 `asAdmin: true` 标识：
```typescript
{
  type: "revoke",
  targetMessageId: "msg-xxx",
  messageId: "revoke-xxx",
  asAdmin: true  // 标识管理员撤回
}
```

### 撤回权限检查逻辑
接收端验证撤回权限时，有三种情况允许撤回：
```typescript
const localIsAdmin = conversation.admins?.includes(envelope.senderId) ?? false;
const isOwner = target.senderId === envelope.senderId;

// 允许撤回的条件（满足任一即可）：
// 1. isOwner: 原发送者撤回自己的消息
// 2. asAdmin: 撤回消息中声明管理员身份（消息已签名验证）
// 3. localIsAdmin: 本地配置中该用户是管理员
if (!isOwner && !asAdmin && !localIsAdmin) {
  return null; // 拒绝撤回
}
```

### 去中心化场景下的边界
- **信任签名**：撤回消息经过发送者签名，接收端验证签名后信任 `asAdmin` 声明
- **无需同步配置**：管理员端发送的撤回消息包含 `asAdmin=true`，其他端即使没有配置管理员列表也能执行撤回
- **安全边界**：恶意用户可伪造 `asAdmin=true`，但无法伪造签名；真正的安全依赖消息签名验证
- **未来改进**：可引入链上注册或群密钥签名的管理员授权机制

### UI 说明
- 加入群聊时可勾选「我是管理员」
- 管理员在聊天界面显示「管理员」徽章
- 管理员可对他人消息显示「撤回(管理)」按钮

## 历史消息
当前实现为 **在线消息**（不接入 Store）。原因：
- 轻节点接入 Store 需额外查询逻辑与索引策略。
- 设计文档中明确该限制；后续可接入 Store 作为加分项。

## 可运行网络
提供 Docker 方式一键启动本地 nwaku，客户端用 `--bootstrap` 连接本地节点。详见 `README.md`。
