import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ConversationRepository } from './conversation.repository';
import type {
  ConversationResult,
  ConversationParticipant,
  ConversationListItem,
  ConversationsPage,
  MessageItem,
  MessagesPage,
} from './conversation.types';

export type {
  ConversationResult,
  ConversationParticipant,
  ConversationListItem,
  ConversationsPage,
  MessageItem,
  MessagesPage,
} from './conversation.types';

@Injectable({ providedIn: 'root' })
export class ConversationsService {
  private repo = inject(ConversationRepository);

  getConversations(cursor?: string, limit = 20): Observable<ConversationsPage> {
    return this.repo.getConversations(cursor, limit);
  }

  getConversationById(id: string): Observable<ConversationListItem> {
    return this.repo.getConversationById(id);
  }

  createOrGetDm(participantDid: string): Observable<ConversationResult> {
    return this.repo.createOrGetDm(participantDid);
  }

  getMessages(conversationId: string, before?: string, limit = 50): Observable<MessagesPage> {
    return this.repo.getMessages(conversationId, before, limit);
  }
}
