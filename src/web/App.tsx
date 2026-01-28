import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrowserChatClient, ConnectionStatus } from "./chatClient";
import { generateIdentity } from "./crypto";
import type { Identity, ConversationConfig, MessageRecord, Participant } from "../sdk/types";

const STORAGE_KEYS = {
  identity: "waku-chat-identity",
  conversations: "waku-chat-conversations",
};

const loadIdentity = (): Identity | null => {
  const stored = localStorage.getItem(STORAGE_KEYS.identity);
  return stored ? JSON.parse(stored) : null;
};

const saveIdentity = (identity: Identity) => {
  localStorage.setItem(STORAGE_KEYS.identity, JSON.stringify(identity));
};

const loadConversations = (): ConversationConfig[] => {
  const stored = localStorage.getItem(STORAGE_KEYS.conversations);
  return stored ? JSON.parse(stored) : [];
};

const saveConversations = (conversations: ConversationConfig[]) => {
  localStorage.setItem(STORAGE_KEYS.conversations, JSON.stringify(conversations));
};

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [client, setClient] = useState<BrowserChatClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [conversations, setConversations] = useState<ConversationConfig[]>([]);
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [inputText, setInputText] = useState("");
  const [showModal, setShowModal] = useState<"dm" | "group" | "export" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize identity
  useEffect(() => {
    const init = async () => {
      let id = loadIdentity();
      if (!id) {
        id = await generateIdentity();
        saveIdentity(id);
      }
      setIdentity(id);

      const convs = loadConversations();
      setConversations(convs);
    };
    init();
  }, []);

  // Initialize client when identity is ready
  useEffect(() => {
    if (!identity) return;

    const chatClient = new BrowserChatClient(identity);
    chatClient.initConversations(loadConversations());
    chatClient.onStatusChange(setStatus);
    setClient(chatClient);

    return () => {
      chatClient.stop();
    };
  }, [identity]);

  // Connect to Waku
  const connect = useCallback(async () => {
    if (!client) return;
    setIsLoading(true);
    try {
      await client.start({ defaultBootstrap: true });
      showToast("已连接到 Waku 网络");
    } catch (e) {
      showToast("连接失败: " + (e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  // Subscribe to active conversation
  useEffect(() => {
    if (!client || status !== "connected" || !activeConversation) return;

    client.subscribe(activeConversation, (msg) => {
      setMessages(client.getMessagesForConversation(activeConversation));
    });
  }, [client, status, activeConversation]);

  // Update messages when conversation changes
  useEffect(() => {
    if (!client || !activeConversation) {
      setMessages([]);
      return;
    }
    setMessages(client.getMessagesForConversation(activeConversation));
  }, [client, activeConversation]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleSend = async () => {
    if (!client || !activeConversation || !inputText.trim()) return;
    try {
      await client.sendMessage(activeConversation, inputText.trim());
      setInputText("");
      setMessages(client.getMessagesForConversation(activeConversation));
    } catch (e) {
      showToast("发送失败: " + (e as Error).message);
    }
  };

  const handleRevoke = async (messageId: string) => {
    if (!client || !activeConversation) return;
    try {
      await client.revokeMessage(activeConversation, messageId);
      setMessages(client.getMessagesForConversation(activeConversation));
      showToast("已撤回");
    } catch (e) {
      showToast("撤回失败: " + (e as Error).message);
    }
  };

  const handleDelete = (messageId: string) => {
    if (!client) return;
    client.deleteLocalMessage(messageId);
    setMessages(client.getMessagesForConversation(activeConversation!));
    showToast("已删除（仅本地）");
  };

  const handleDeleteConversation = (conversationId: string) => {
    if (!client) return;
    if (!confirm("确定删除该会话？所有消息将被清除。")) return;
    
    client.leaveConversation(conversationId);
    const updated = conversations.filter((c) => c.id !== conversationId);
    setConversations(updated);
    saveConversations(updated);
    
    if (activeConversation === conversationId) {
      setActiveConversation(null);
      setMessages([]);
    }
    showToast("会话已删除");
  };

  const handleCreateDm = async (peerJson: string) => {
    if (!client || !identity) return;
    try {
      const peer = JSON.parse(peerJson) as Participant;
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
      client.joinConversation(conversation);
      const updated = [...conversations.filter((c) => c.id !== conversationId), conversation];
      setConversations(updated);
      saveConversations(updated);
      setActiveConversation(conversationId);
      setShowModal(null);
      showToast("私聊已创建");
    } catch (e) {
      showToast("创建失败: " + (e as Error).message);
    }
  };

  const handleJoinGroup = (groupId: string, secret: string, isAdmin: boolean) => {
    if (!client || !identity) return;
    const conversation: ConversationConfig = {
      id: groupId,
      type: "group",
      groupSecret: secret,
      admins: isAdmin ? [identity.id] : [],
      participants: [
        {
          id: identity.id,
          signingPublicKeyPem: identity.signingPublicKeyPem,
          dhPublicKeyPem: identity.dhPublicKeyPem,
        },
      ],
    };
    client.joinConversation(conversation);
    const updated = [...conversations.filter((c) => c.id !== groupId), conversation];
    setConversations(updated);
    saveConversations(updated);
    setActiveConversation(groupId);
    setShowModal(null);
    showToast(isAdmin ? "已加入群聊（管理员）" : "已加入群聊");
  };

  const activeConv = conversations.find((c) => c.id === activeConversation);

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Waku Mini Chat</h1>
          {identity && (
            <div className="identity">ID: {identity.id.slice(0, 16)}...</div>
          )}
        </div>

        {/* Connection */}
        <div className={`connection-panel ${status}`}>
          <div className="status">
            <span
              className={`status-dot ${status}`}
            />
            {status === "connected"
              ? "已连接"
              : status === "connecting"
              ? "连接中..."
              : "未连接"}
          </div>
          {status === "disconnected" && (
            <button
              className="btn btn-primary btn-sm"
              onClick={connect}
              disabled={isLoading}
            >
              {isLoading ? "连接中..." : "连接 Waku"}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="sidebar-section">
          <h3>操作</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-outline btn-sm" onClick={() => setShowModal("dm")}>
              + 私聊
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => setShowModal("group")}>
              + 群聊
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => setShowModal("export")}>
              导出身份
            </button>
          </div>
        </div>

        {/* Conversations */}
        <div className="sidebar-section">
          <h3>会话列表</h3>
        </div>
        <div className="conversation-list">
          {conversations.length === 0 ? (
            <div style={{ padding: 16, color: "#718096", fontSize: 13 }}>
              暂无会话，点击上方按钮创建
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`conversation-item ${conv.id === activeConversation ? "active" : ""}`}
                onClick={() => setActiveConversation(conv.id)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div className="name">
                      {conv.type === "dm" ? "🔒 " : "👥 "}
                      {conv.id.length > 20 ? conv.id.slice(0, 20) + "..." : conv.id}
                    </div>
                    <div className="type">{conv.type === "dm" ? "私聊" : "群聊"}</div>
                  </div>
                  <button
                    className="conv-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConversation(conv.id);
                    }}
                    title="删除会话"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main */}
      <div className="main">
        {activeConv ? (
          <>
            <div className="main-header">
              <h2>
                {activeConv.type === "dm" ? "🔒 私聊" : "👥 群聊"}: {activeConv.id.slice(0, 20)}...
                {client?.isAdmin(activeConv.id) && (
                  <span className="admin-badge">管理员</span>
                )}
              </h2>
              <div className="status">
                <span className={`status-dot ${status}`} />
                {status === "connected" ? "在线" : "离线"}
              </div>
            </div>

            <div className="messages">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="icon">💬</div>
                  <h3>暂无消息</h3>
                  <p>发送第一条消息开始聊天</p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isSelf = msg.senderId === identity?.id;
                  const canRevoke = isSelf || (client?.isAdmin(activeConversation!) ?? false);
                  
                  return (
                    <div
                      key={msg.id}
                      className={`message ${isSelf ? "sent" : "received"} ${
                        msg.status === "revoked" ? "revoked" : ""
                      }`}
                    >
                      {!isSelf && (
                        <div className="sender">{msg.senderId.slice(0, 12)}...</div>
                      )}
                      <div className="text">
                        {msg.status === "revoked" ? "[消息已撤回]" : msg.text}
                      </div>
                      <div className="meta">
                        <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        {msg.status !== "revoked" && (
                          <div className="actions">
                            {canRevoke && (
                              <button
                                className="action-btn"
                                onClick={() => handleRevoke(msg.id)}
                              >
                                撤回{!isSelf && "(管理)"}
                              </button>
                            )}
                            {isSelf && (
                              <button
                                className="action-btn"
                                onClick={() => handleDelete(msg.id)}
                              >
                                删除
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              <input
                type="text"
                placeholder={status === "connected" ? "输入消息..." : "请先连接 Waku"}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                disabled={status !== "connected"}
              />
              <button onClick={handleSend} disabled={status !== "connected" || !inputText.trim()}>
                发送
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="icon">👈</div>
            <h3>选择或创建会话</h3>
            <p>从左侧选择一个会话，或创建新的私聊/群聊</p>
          </div>
        )}
      </div>

      {/* Modals */}
      {showModal === "dm" && (
        <CreateDmModal onClose={() => setShowModal(null)} onCreate={handleCreateDm} />
      )}
      {showModal === "group" && (
        <JoinGroupModal onClose={() => setShowModal(null)} onJoin={handleJoinGroup} />
      )}
      {showModal === "export" && identity && (
        <ExportIdentityModal identity={identity} onClose={() => setShowModal(null)} />
      )}

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function CreateDmModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (peerJson: string) => void;
}) {
  const [peerJson, setPeerJson] = useState("");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>创建私聊</h3>
        <div className="form-group">
          <label>对方公钥信息（JSON）</label>
          <textarea
            placeholder='粘贴对方的身份 JSON，包含 id, signingPublicKeyPem, dhPublicKeyPem'
            value={peerJson}
            onChange={(e) => setPeerJson(e.target.value)}
          />
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onCreate(peerJson)}
            disabled={!peerJson.trim()}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function JoinGroupModal({
  onClose,
  onJoin,
}: {
  onClose: () => void;
  onJoin: (groupId: string, secret: string, isAdmin: boolean) => void;
}) {
  const [groupId, setGroupId] = useState("");
  const [secret, setSecret] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>加入群聊</h3>
        <div className="form-group">
          <label>群聊 ID</label>
          <input
            type="text"
            placeholder="例如: my-group-1"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>群聊密钥</label>
          <input
            type="text"
            placeholder="所有成员需使用相同密钥"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              style={{ width: "auto" }}
            />
            <span>我是管理员（可撤回他人消息）</span>
          </label>
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onJoin(groupId, secret, isAdmin)}
            disabled={!groupId.trim() || !secret.trim()}
          >
            加入
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportIdentityModal({
  identity,
  onClose,
}: {
  identity: Identity;
  onClose: () => void;
}) {
  const publicInfo = {
    id: identity.id,
    signingPublicKeyPem: identity.signingPublicKeyPem,
    dhPublicKeyPem: identity.dhPublicKeyPem,
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(publicInfo, null, 2));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>导出身份</h3>
        <p style={{ fontSize: 13, color: "#718096", marginBottom: 12 }}>
          将以下 JSON 分享给对方以创建私聊：
        </p>
        <div className="form-group">
          <textarea
            readOnly
            value={JSON.stringify(publicInfo, null, 2)}
            style={{ height: 200 }}
          />
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleCopy}>
            复制
          </button>
        </div>
      </div>
    </div>
  );
}
