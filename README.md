# Waku Mini Chat

基于 Waku JS SDK 的"迷你加密聊天"封装与 Demo，支持单聊、群聊、撤回与本地删除。

## 功能概览
- 单聊 / 群聊
- 消息加密与签名（AES-256-GCM + Ed25519/ECDSA）
- 撤回（tombstone 控制消息）
- 本地删除
- **Web UI（推荐）** + CLI Demo
- 单元测试（内存传输模拟）

## 安装依赖
```bash
npm install
```

---

## 🌐 Web UI（推荐）

最简单的使用方式：

```bash
npm run dev:web
```

打开浏览器访问 **http://localhost:5173**

### Web UI 使用流程

1. **连接网络**：点击左侧「连接 Waku」按钮（使用公共 bootstrap 节点）
2. **导出身份**：点击「导出身份」获取你的公钥 JSON
3. **创建私聊**：
   - 将你的身份 JSON 分享给对方
   - 对方也导出他的身份 JSON 给你
   - 点击「+ 私聊」粘贴对方的 JSON
4. **加入群聊**：
   - 点击「+ 群聊」
   - 输入群 ID 和共享密钥（所有成员需一致）
5. **发送/撤回/删除**：
   - 输入消息后按 Enter 或点击发送
   - 鼠标悬停自己的消息可撤回或删除

### 截图示例

```
┌─────────────────┬────────────────────────────────────────┐
│  Waku Mini Chat │  🔒 私聊: dm:abc...                     │
│  ID: 8f3a...    │                                        │
│─────────────────│  [收到] 8f3a: hello                    │
│  ● 已连接       │                    [发送] hi there     │
│─────────────────│                                        │
│  + 私聊         │                                        │
│  + 群聊         │                                        │
│  导出身份       │                                        │
│─────────────────│  ┌────────────────────────┐ ┌────┐     │
│  🔒 dm:abc...   │  │ 输入消息...            │ │发送│     │
│  👥 group-1     │  └────────────────────────┘ └────┘     │
└─────────────────┴────────────────────────────────────────┘
```

---

## 📟 CLI Demo

### 一键启动本地 Waku 节点
需要 Docker：
```bash
npm run start:local-node
```
该命令会启动 nwaku 容器并输出可用于连接的 `multiaddr`。后续 CLI 用 `--bootstrap` 指向该地址。

> 如果你更倾向连接公共网络，CLI 支持 `--public` 使用默认 bootstrap。

### 快速演示（单聊）

#### 终端 A
```bash
npm run demo init
npm run demo export-identity -- --out alice.json
```

#### 终端 B
```bash
npm run demo init
npm run demo export-identity -- --out bob.json
```

#### A 创建私聊并监听
```bash
npm run demo create-dm -- --peer bob.json
npm run demo listen -- --conversation <conversationId> --bootstrap <multiaddr>
```

#### B 创建私聊并监听
```bash
npm run demo create-dm -- --peer alice.json
npm run demo listen -- --conversation <conversationId> --bootstrap <multiaddr>
```

#### A 发送消息
```bash
npm run demo send -- --conversation <conversationId> --text "hello" --bootstrap <multiaddr>
```

### 快速演示（群聊）
三端都执行（替换为各自 data-dir）：
```bash
npm run demo join-group -- --id group-1 --secret "group-secret"
npm run demo listen -- --conversation group-1 --bootstrap <multiaddr>
```
任意一端发送：
```bash
npm run demo send -- --conversation group-1 --text "hi group" --bootstrap <multiaddr>
```

### 撤回与删除
撤回：
```bash
npm run demo revoke -- --conversation <conversationId> --message-id <messageId> --bootstrap <multiaddr>
```
删除（仅本地）：
```bash
npm run demo delete -- --message-id <messageId>
```

---

## 单元测试
```bash
npm test
```

## 设计说明
详见 `docs/design.md`。

## 复盘清单
详见 `docs/retro.md`。

## 参考资料
- Waku 框架与概念：[https://waku.gg](https://waku.gg)
- LightPush/Filter 发送与接收：[https://docs.waku.org/build/javascript/light-send-receive/](https://docs.waku.org/build/javascript/light-send-receive/)
- Waku message hash 定义：[https://js.waku.org/functions/_waku_sdk.waku.messageHash.html](https://js.waku.org/functions/_waku_sdk.waku.messageHash.html)
