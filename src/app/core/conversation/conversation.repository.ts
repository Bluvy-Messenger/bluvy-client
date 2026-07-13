import { Injectable, inject } from '@angular/core';
import { Observable, from } from 'rxjs';
import { map } from 'rxjs/operators';
import type {
  ConversationListItem,
  ConversationResult,
  ConversationsPage,
  MessagesPage,
} from './conversation.types';
import {
  mapConversationListItem,
  mapConversationResult,
  mapConversationsPage,
  mapMessagesPage,
} from './conversation.mapper';
import { ApiClientService } from '../infrastructure/api-client.service';

@Injectable({ providedIn: 'root' })
export class ConversationRepository {
  private apiClient = inject(ApiClientService);

  getConversations(cursor?: string, limit = 20, archived?: boolean): Observable<ConversationsPage> {
    const params: Record<string, string> = { limit: String(limit) };
    if (cursor) params['cursor'] = cursor;
    if (archived !== undefined) params['archived'] = String(archived);
    return from(this.apiClient.get<ConversationsPage>('/v1/conversations', { params })).pipe(
      map(mapConversationsPage),
    );
  }

  getConversationById(id: string): Observable<ConversationListItem> {
    return from(this.apiClient.get<ConversationListItem>(`/v1/conversations/${id}`)).pipe(
      map(mapConversationListItem),
    );
  }

  createOrGetDm(participantDid: string): Observable<ConversationResult> {
    return from(this.apiClient.post<ConversationResult>('/v1/conversations', { participantDid })).pipe(
      map(mapConversationResult),
    );
  }

  getMessages(conversationId: string, before?: string, limit = 50): Observable<MessagesPage> {
    const params: Record<string, string> = { limit: String(limit) };
    if (before) params['before'] = before;
    return from(this.apiClient.get<MessagesPage>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      { params },
    )).pipe(
      map(mapMessagesPage),
    );
  }

  deleteConversation(id: string): Observable<void> {
    return from(this.apiClient.delete<void>(`/v1/conversations/${encodeURIComponent(id)}`));
  }

  archiveConversation(id: string, archived: boolean): Observable<void> {
    return from(this.apiClient.post<void>(`/v1/conversations/${encodeURIComponent(id)}/archive`, { archived }));
  }
}
