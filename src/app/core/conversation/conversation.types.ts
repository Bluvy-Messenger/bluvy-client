import type { Paginated } from '../infrastructure/pagination.types';

export interface ConversationResult {
  id:            string;
  type:          string;
  createdAt:     number;
  lastMessageAt: number | null;
}

// Response shape for POST /v1/conversations/:id/recreate (Root Cause #3
// fallback — see AUDIT_02/04/05, Phase 9).
export interface RecreateConversationResult {
  oldConversationId: string;
  newConversation:   ConversationResult;
}

export interface ConversationParticipant {
  did:         string;
  handle:      string;
  displayName: string | null;
  avatarUrl:   string | null;
}

export interface ConversationListItem {
  id:                   string;
  type:                 string;
  name?:                string | null;
  avatarUrl?:           string | null;
  ownerDid?:            string | null;
  createdAt:            number;
  lastMessageAt:        number | null;
  lastMessageId:        string | null;
  lastMessageSenderDid: string | null;
  unreadCount:          number;
  participant:          ConversationParticipant;
  members?:             ConversationParticipant[];
  memberCount?:         number;
  archived?:            boolean;
  supersededByConversationId?: string | null;
  predecessorConversationId?: string | null;
}

export type ConversationsPage = Paginated<ConversationListItem>;

export interface MessageItem {
  id:             string;
  conversationId: string;
  senderDeviceId: string;
  senderDid:      string;
  ciphertext:     string;
  createdAt:      number;
}

export type MessagesPage = Paginated<MessageItem>;

export interface MessageReplyTo {
  messageId:       string;
  senderDid:       string;
  senderHandle?:   string;
  textSnippet:     string;
  mediaThumbnail?: string;
}

export interface ReactionPayload {
  targetMessageId: string;
  emoji:           string;
  action:          'add' | 'remove';
}

export type ReactionMap = Record<string, string[]>; // emoji -> array of user DIDs

export interface CachedMessage {
  id:                string;
  conversationId:    string;
  senderDeviceId:    string;
  senderDid?:        string;
  plaintext:         string;
  isMine:            boolean;
  undecryptable:     boolean;
  cacheVersion:      number;
  encryptionVersion: number;
  deletedAt:         number | null;
  createdAt:         number;
  cachedAt:          number;
  replyTo?:          MessageReplyTo | null;
  reactions?:        ReactionMap;
}

export interface MessageCacheReadResult {
  messages: CachedMessage[];
  ids:      Set<string>;
}

export interface DisplayMessage {
  id:          string;
  displayText: string;
  isMine:      boolean;
  createdAt:   number;
  pending:     boolean;
  senderDid?:  string;
  replyTo?:    MessageReplyTo | null;
  reactions?:  ReactionMap;
}

