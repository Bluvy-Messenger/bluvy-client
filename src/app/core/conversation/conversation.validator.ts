import type { ConversationListItem, ConversationResult, ConversationsPage, MessageItem, MessagesPage } from './conversation.types';
import { isObject } from '../infrastructure/validation.util';

export function validateConversationResult(data: ConversationResult): ConversationResult {
  if (!isObject(data)) throw new Error('ConversationResult: expected object');
  if (typeof data['id'] !== 'string') throw new Error('ConversationResult.id: expected string');
  if (typeof data['type'] !== 'string') throw new Error('ConversationResult.type: expected string');
  if (typeof data['createdAt'] !== 'number') throw new Error('ConversationResult.createdAt: expected number');
  if (data['lastMessageAt'] !== null && typeof data['lastMessageAt'] !== 'number') {
    throw new Error('ConversationResult.lastMessageAt: expected number or null');
  }
  return data;
}

export function validateMessageItem(data: MessageItem): MessageItem {
  if (!isObject(data)) throw new Error('MessageItem: expected object');
  if (typeof data['id'] !== 'string') throw new Error('MessageItem.id: expected string');
  if (typeof data['conversationId'] !== 'string') throw new Error('MessageItem.conversationId: expected string');
  if (typeof data['senderDeviceId'] !== 'string') throw new Error('MessageItem.senderDeviceId: expected string');
  if (typeof data['senderDid'] !== 'string') throw new Error('MessageItem.senderDid: expected string');
  if (typeof data['ciphertext'] !== 'string') throw new Error('MessageItem.ciphertext: expected string');
  if (typeof data['createdAt'] !== 'number') throw new Error('MessageItem.createdAt: expected number');
  return data;
}

export function validateConversationListItem(data: ConversationListItem): ConversationListItem {
  if (!isObject(data)) throw new Error('ConversationListItem: expected object');
  if (typeof data['id'] !== 'string') throw new Error('ConversationListItem.id: expected string');
  return data;
}

export function validateMessagesPage(data: MessagesPage): MessagesPage {
  if (!isObject(data)) throw new Error('MessagesPage: expected object');
  if (!Array.isArray(data['data'])) throw new Error('MessagesPage.data: expected array');
  return data;
}

export function validateConversationsPage(data: ConversationsPage): ConversationsPage {
  if (!isObject(data)) throw new Error('ConversationsPage: expected object');
  if (!Array.isArray(data['data'])) throw new Error('ConversationsPage.data: expected array');
  return data;
}
