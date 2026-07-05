import type { ConversationListItem, ConversationResult, ConversationsPage, MessageItem, MessagesPage } from './conversation.types';
import {
  validateConversationListItem,
  validateConversationResult,
  validateConversationsPage,
  validateMessageItem,
  validateMessagesPage,
} from './conversation.validator';

export function mapConversationListItem(dto: ConversationListItem): ConversationListItem {
  return validateConversationListItem(dto);
}

export function mapConversationResult(dto: ConversationResult): ConversationResult {
  return validateConversationResult(dto);
}

export function mapConversationsPage(dto: ConversationsPage): ConversationsPage {
  return validateConversationsPage(dto);
}

export function mapMessageItem(dto: MessageItem): MessageItem {
  return validateMessageItem(dto);
}

export function mapMessagesPage(dto: MessagesPage): MessagesPage {
  return validateMessagesPage(dto);
}
