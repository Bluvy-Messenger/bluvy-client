import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { ApiClientService } from '../infrastructure/api-client.service';
import { SocketService } from '../infrastructure/socket.service';

interface ReadStateEntry {
  conversationId: string;
  readerDid: string;
  lastReadMessageId: string;
}

@Injectable({ providedIn: 'root' })
export class ReceiptsService implements OnDestroy {
  private readonly socketSvc = inject(SocketService);
  private readonly authSvc   = inject(AuthService);
  private readonly apiClient = inject(ApiClientService);
  private readonly sub       = new Subscription();

  // lastReadMessageId per (conversationId → readerDid)
  private readonly readStates     = new Map<string, Map<string, string>>();
  // unread count per conversationId
  private readonly unreadSubjects = new Map<string, BehaviorSubject<number>>();

  private readonly _totalUnread = new BehaviorSubject<number>(0);
  readonly totalUnread$: Observable<number> = this._totalUnread.asObservable();

  // conversationId → Set of delivered messageIds
  private readonly deliveredStates = new Map<string, Set<string>>();

  constructor() {
    this.sub.add(
      this.socketSvc.receiptUpdate$.subscribe(({ conversationId, lastReadMessageId, readerDid }) => {
        let convStates = this.readStates.get(conversationId);
        if (!convStates) {
          convStates = new Map();
          this.readStates.set(conversationId, convStates);
        }
        convStates.set(readerDid, lastReadMessageId);

        const myDid = this.authSvc.currentUser()?.did;
        if (myDid && readerDid === myDid) {
          this.setCount(conversationId, 0);
        }
      }),
    );

    this.sub.add(
      this.socketSvc.receiptDelivered$.subscribe(({ conversationId, messageId }) => {
        let delivered = this.deliveredStates.get(conversationId);
        if (!delivered) {
          delivered = new Set();
          this.deliveredStates.set(conversationId, delivered);
        }
        delivered.add(messageId);
      }),
    );

    this.sub.add(
      this.socketSvc.messageNew$.subscribe(({ conversationId, senderDid }) => {
        const myDid = this.authSvc.currentUser()?.did;
        if (myDid && senderDid !== myDid) {
          const current = this.getUnreadSubject(conversationId).getValue();
          this.setCount(conversationId, current + 1);
        }
      }),
    );

    this.sub.add(
      this.socketSvc.reconnect$.subscribe(() => void this.initReadStates()),
    );
  }

  markConversationRead(conversationId: string, lastMessageId: string): void {
    this.setCount(conversationId, 0);
    this.socketSvc.sendConversationRead(conversationId, lastMessageId);
  }

  isDeliveredToPartner(conversationId: string, messageId: string): boolean {
    return this.deliveredStates.get(conversationId)?.has(messageId) ?? false;
  }

  // Returns true if partnerDid has read up to or past messageId (UUID v7 lexicographic order).
  isReadByPartner(conversationId: string, messageId: string, partnerDid: string): boolean {
    const partnerLastRead = this.readStates.get(conversationId)?.get(partnerDid);
    if (!partnerLastRead) return false;
    return partnerLastRead >= messageId;
  }

  unreadCount$(conversationId: string): Observable<number> {
    return this.getUnreadSubject(conversationId).asObservable();
  }

  setUnreadCounts(counts: Record<string, number>): void {
    for (const [convId, count] of Object.entries(counts)) {
      this.getUnreadSubject(convId).next(count);
    }
    this.recalcTotal();
  }

  async initReadStates(): Promise<void> {
    const data = await this.apiClient.get<{ states: ReadStateEntry[] }>('/v1/receipts/states');
    this.setReadStates(data.states);
  }

  setReadStates(states: ReadStateEntry[]): void {
    for (const { conversationId, readerDid, lastReadMessageId } of states) {
      let convMap = this.readStates.get(conversationId);
      if (!convMap) {
        convMap = new Map<string, string>();
        this.readStates.set(conversationId, convMap);
      }
      convMap.set(readerDid, lastReadMessageId);
    }
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  private setCount(conversationId: string, count: number): void {
    this.getUnreadSubject(conversationId).next(count);
    this.recalcTotal();
  }

  private recalcTotal(): void {
    let total = 0;
    this.unreadSubjects.forEach(s => { total += s.getValue(); });
    this._totalUnread.next(total);
  }

  private getUnreadSubject(conversationId: string): BehaviorSubject<number> {
    let subject = this.unreadSubjects.get(conversationId);
    if (!subject) {
      subject = new BehaviorSubject<number>(0);
      this.unreadSubjects.set(conversationId, subject);
    }
    return subject;
  }
}
