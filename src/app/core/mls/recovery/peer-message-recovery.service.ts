import { Injectable, inject } from '@angular/core';
import { Subject, Observable, firstValueFrom } from 'rxjs';
import { SocketService } from '../../infrastructure/socket.service';
import type { MessageResendRequestPayload, MessageResentPayload } from '../../infrastructure/socket.types';
import { MessageCacheService } from '../../conversation/message-cache.service';
import { MlsCoordinatorBase } from '../coordinator/mls-coordinator.base';
import { AuthService } from '../../auth/auth.service';
import { ConversationsService } from '../../conversation/conversations.service';
import { SyncService } from '../../sync/sync.service';
import type { CachedMessage } from '../../conversation/conversation.types';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class PeerMessageRecoveryService {
  private socketSvc       = inject(SocketService);
  private messageCacheSvc = inject(MessageCacheService);
  private coordinator     = inject(MlsCoordinatorBase);
  private authSvc         = inject(AuthService);
  private convSvc         = inject(ConversationsService);
  private syncSvc         = inject(SyncService);

  private readonly MAX_ATTEMPTS = 3;
  private static readonly ATTEMPTS_KEY = 'bluvy-resend-attempts';
  private static readonly ATTEMPTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // messageId -> { n: attempts, at: last attempt ms }. Persisted so a page
  // reload doesn't silently reset the budget, pruned after 7 days (F5).
  private requestAttempts = new Map<string, { n: number; at: number }>();

  private readonly _messageRecovered$$ = new Subject<CachedMessage>();
  readonly messageRecovered$: Observable<CachedMessage> = this._messageRecovered$$.asObservable();

  constructor() {
    this.loadAttempts();

    this.socketSvc.messageResendRequested$.subscribe(payload => {
      void this.handleResendRequest(payload);
    });

    this.socketSvc.messageResent$.subscribe(payload => {
      void this.handleResentMessage(payload);
    });

    // A reconnect changes which peers are online -- the device that holds the
    // plaintext may have just come back. Reset the budget so the next
    // conversation open / catch-up sweep re-issues the request (F5).
    this.socketSvc.reconnect$.subscribe(() => {
      this.requestAttempts.clear();
      this.persistAttempts();
    });
  }

  /**
   * Called when a message is received or loaded and cannot be decrypted.
   * Emits a discrete resend request over WebSocket (bounded by MAX_ATTEMPTS,
   * persisted across reloads, reset on reconnect).
   */
  requestResend(conversationId: string, messageId: string): void {
    const rec = this.requestAttempts.get(messageId);
    const attempts = rec?.n ?? 0;
    if (attempts >= this.MAX_ATTEMPTS) return;

    this.requestAttempts.set(messageId, { n: attempts + 1, at: Date.now() });
    this.persistAttempts();
    if (!environment.production) {
      console.log('[PeerMessageRecovery] Requesting resend for undecryptable message:', messageId, 'attempt:', attempts + 1);
    }
    this.socketSvc.requestMessageResend(conversationId, messageId);
  }

  private loadAttempts(): void {
    try {
      const raw = localStorage.getItem(PeerMessageRecoveryService.ATTEMPTS_KEY);
      if (!raw) return;
      const cutoff = Date.now() - PeerMessageRecoveryService.ATTEMPTS_TTL_MS;
      const parsed = JSON.parse(raw) as Record<string, { n: number; at: number }>;
      for (const [id, v] of Object.entries(parsed)) {
        if (v && typeof v.n === 'number' && typeof v.at === 'number' && v.at >= cutoff) {
          this.requestAttempts.set(id, v);
        }
      }
    } catch { /* corrupt / unavailable -- start fresh */ }
  }

  private persistAttempts(): void {
    try {
      localStorage.setItem(
        PeerMessageRecoveryService.ATTEMPTS_KEY,
        JSON.stringify(Object.fromEntries(this.requestAttempts)),
      );
    } catch { /* ignore */ }
  }

  /**
   * Responding device: When another peer requests a resend of a message,
   * check if we have the plaintext in our local cache. If so, re-encrypt
   * with current epoch and emit back.
   */
  private async handleResendRequest(payload: MessageResendRequestPayload): Promise<void> {
    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    try {
      await this.messageCacheSvc.initialize(user.did, device.id);
      const cached = await this.messageCacheSvc.getById(payload.messageId);
      if (!cached || cached.undecryptable || !cached.plaintext) {
        // We don't have the plaintext for this message
        return;
      }

      if (!environment.production) {
        console.log('[PeerMessageRecovery] Fulfilling resend request for message:', payload.messageId);
      }

      const conv = await firstValueFrom(this.convSvc.getConversationById(payload.conversationId)).catch(() => null);
      const participantDid = conv?.participant?.did;
      const memberDids = conv?.members?.map(m => m.did);

      if (participantDid) {
        await this.coordinator.ensureGroupReady(
          payload.conversationId,
          participantDid,
          user,
          device,
          undefined,
          undefined,
          memberDids,
        );
      }

      const newCiphertext = await this.coordinator.encryptMessage(
        payload.conversationId,
        cached.plaintext,
        user,
        device,
      );

      this.socketSvc.resendMessage(payload.conversationId, payload.messageId, newCiphertext);
      if (!environment.production) {
        console.log('[PeerMessageRecovery] Successfully resent re-encrypted message:', payload.messageId);
      }
    } catch (err) {
      if (!environment.production) {
        console.warn('[PeerMessageRecovery] Failed to handle resend request for message:', payload.messageId, err);
      }
    }
  }

  /**
   * Requesting device: When a resent ciphertext arrives, attempt decryption.
   * If successful, update local cache and emit messageRecovered$.
   */
  private async handleResentMessage(payload: MessageResentPayload): Promise<void> {
    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    try {
      await this.messageCacheSvc.initialize(user.did, device.id);
      const cached = await this.messageCacheSvc.getById(payload.messageId);
      if (!cached || !cached.undecryptable) {
        // Message is either unknown or already decrypted
        return;
      }

      if (!environment.production) {
        console.log('[PeerMessageRecovery] Attempting to decrypt resent message:', payload.messageId);
      }

      const senderDid = cached.senderDid ?? user.did;
      const result = await this.coordinator.decryptMessage(
        payload.conversationId,
        payload.messageId,
        senderDid,
        cached.senderDeviceId,
        cached.isMine,
        cached.createdAt,
        payload.ciphertext,
        user,
        device,
      );

      if (result.state === 'plaintext') {
        const updated: CachedMessage = {
          ...cached,
          plaintext:     result.plaintext,
          undecryptable: false,
          cachedAt:      Date.now(),
        };

        await this.messageCacheSvc.store(updated);
        this.syncSvc.enqueue({
          messageId:      updated.id,
          conversationId: updated.conversationId,
          plaintext:      result.plaintext,
          createdAt:      updated.createdAt,
          senderDid,
        });

        this.requestAttempts.delete(payload.messageId);
        this.persistAttempts();
        this._messageRecovered$$.next(updated);
        if (!environment.production) {
          console.log('[PeerMessageRecovery] Successfully recovered message in plaintext:', payload.messageId);
        }
      }
    } catch (err) {
      if (!environment.production) {
        console.warn('[PeerMessageRecovery] Decryption of resent message failed:', payload.messageId, err);
      }
    }
  }
}
