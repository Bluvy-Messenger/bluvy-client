import type { Paginated } from '../infrastructure/pagination.types';

export interface ConversationResult {
  id:            string;
  type:          string;
  createdAt:     number;
  lastMessageAt: number | null;
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
  createdAt:            number;
  lastMessageAt:        number | null;
  lastMessageId:        string | null;
  lastMessageSenderDid: string | null;
  unreadCount:          number;
  participant:          ConversationParticipant;
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
}
