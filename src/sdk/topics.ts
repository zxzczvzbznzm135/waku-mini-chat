export const PUBSUB_TOPIC = "/waku/2/default-waku/proto";

export const contentTopicForConversation = (conversationId: string) =>
  `/waku-mini-chat/1/${conversationId}/json`;
