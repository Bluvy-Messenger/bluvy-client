import { Injectable, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ConversationRepository } from './conversation.repository';
import { AnalyticsService } from '../analytics/analytics.service';
import type {
  ConversationResult,
  ConversationParticipant,
  ConversationListItem,
  ConversationsPage,
  MessageItem,
  MessagesPage,
  RecreateConversationResult,
} from './conversation.types';

export type {
  ConversationResult,
  ConversationParticipant,
  ConversationListItem,
  ConversationsPage,
  MessageItem,
  MessagesPage,
  RecreateConversationResult,
} from './conversation.types';

@Injectable({ providedIn: 'root' })
export class ConversationsService {
  private repo = inject(ConversationRepository);
  private analyticsSvc = inject(AnalyticsService);

  private conversationDeletedSubject = new Subject<string>();
  conversationDeleted$ = this.conversationDeletedSubject.asObservable();

  private conversationArchivedSubject = new Subject<{ id: string; archived: boolean }>();
  conversationArchived$ = this.conversationArchivedSubject.asObservable();

  getConversations(cursor?: string, limit = 20, archived?: boolean): Observable<ConversationsPage> {
    return this.repo.getConversations(cursor, limit, archived);
  }

  getConversationById(id: string): Observable<ConversationListItem> {
    return this.repo.getConversationById(id);
  }

  createOrGetDm(participantDid: string): Observable<ConversationResult> {
    return this.repo.createOrGetDm(participantDid).pipe(
      tap(() => {
        this.analyticsSvc.trackEvent('Messaging', 'conversation_created', 'dm');
      })
    );
  }

  getMessages(conversationId: string, before?: string, limit = 50): Observable<MessagesPage> {
    return this.repo.getMessages(conversationId, before, limit);
  }

  deleteConversation(id: string): Observable<void> {
    return this.repo.deleteConversation(id).pipe(
      tap(() => this.conversationDeletedSubject.next(id))
    );
  }

  archiveConversation(id: string, archived: boolean): Observable<void> {
    return this.repo.archiveConversation(id, archived).pipe(
      tap(() => this.conversationArchivedSubject.next({ id, archived }))
    );
  }

  recreateConversation(id: string): Observable<RecreateConversationResult> {
    return this.repo.recreateConversation(id);
  }

  createGroupConversation(participantDids: string[], name?: string): Observable<ConversationListItem> {
    return this.repo.createGroupConversation(participantDids, name).pipe(
      tap(() => {
        this.analyticsSvc.trackEvent('Messaging', 'conversation_created', 'group', participantDids.length);
      })
    );
  }

  updateGroupName(id: string, name: string): Observable<ConversationListItem> {
    return this.repo.updateGroupName(id, name);
  }

  fetchServerConfig(): Observable<{ maxGroupMembers: number }> {
    return this.repo.fetchServerConfig();
  }
}
