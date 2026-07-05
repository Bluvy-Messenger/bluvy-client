import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { SocketService } from '../infrastructure/socket.service';

@Injectable({ providedIn: 'root' })
export class TypingService implements OnDestroy {
  private readonly socketSvc = inject(SocketService);
  private readonly sub       = new Subscription();

  private readonly typingMap   = new Map<string, BehaviorSubject<string[]>>();
  private readonly MAX_TRACKED = 100;

  private _activeConvId:  string | null                      = null;
  private _isTyping:      boolean                            = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly DEBOUNCE_MS = 3_000;

  constructor() {
    this.sub.add(
      this.socketSvc.typingStart$.subscribe(({ conversationId, senderDid }) => {
        this.addTyper(conversationId, senderDid);
      }),
    );
    this.sub.add(
      this.socketSvc.typingStop$.subscribe(({ conversationId, senderDid }) => {
        this.removeTyper(conversationId, senderDid);
      }),
    );
  }

  typingUsers$(conversationId: string): Observable<string[]> {
    return this.getSubject(conversationId).asObservable();
  }

  startTyping(conversationId: string): void {
    this._activeConvId = conversationId;

    if (!this._isTyping) {
      this._isTyping = true;
      this.socketSvc.sendTypingStart(conversationId);
    }

    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this.stopTyping(conversationId);
    }, this.DEBOUNCE_MS);
  }

  stopTyping(conversationId: string): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._isTyping && this._activeConvId === conversationId) {
      this._isTyping     = false;
      this._activeConvId = null;
      this.socketSvc.sendTypingStop(conversationId);
    }
  }

  ngOnDestroy(): void {
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this.sub.unsubscribe();
  }

  private getSubject(conversationId: string): BehaviorSubject<string[]> {
    let subject = this.typingMap.get(conversationId);
    if (!subject) {
      if (this.typingMap.size >= this.MAX_TRACKED) {
        const firstKey = this.typingMap.keys().next().value as string | undefined;
        if (firstKey !== undefined) this.typingMap.delete(firstKey);
      }
      subject = new BehaviorSubject<string[]>([]);
      this.typingMap.set(conversationId, subject);
    }
    return subject;
  }

  private addTyper(conversationId: string, senderDid: string): void {
    const subject = this.getSubject(conversationId);
    const current = subject.getValue();
    if (!current.includes(senderDid)) {
      subject.next([...current, senderDid]);
    }
  }

  private removeTyper(conversationId: string, senderDid: string): void {
    const subject = this.typingMap.get(conversationId);
    if (!subject) return;
    const current = subject.getValue();
    const next    = current.filter(did => did !== senderDid);
    if (next.length !== current.length) subject.next(next);
  }
}
