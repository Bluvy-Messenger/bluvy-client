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

  private readonly requestAttempts = new Map<string, number>();
  private readonly MAX_ATTEMPTS = 2;

  private readonly _messageRecovered$$ = new Subject<CachedMessage>();
  readonly messageRecovered$: Observable<CachedMessage> = this._messageRecovered$$.asObservable();

  constructor() {
    this.socketSvc.messageResendRequested$.subscribe(payload => {
      void this.handleResendRequest(payload);
    });

    this.socketSvc.messageResent$.subscribe(payload => {
      void this.handleResentMessage(payload);
    });
  }

  /**
   * Called when a message is received or loaded and cannot be decrypted.
   * Emits a discrete resend request over WebSocket (bounded by MAX_ATTEMPTS).
   */
  requestResend(conversationId: string, messageId: string): void {
    const attempts = this.requestAttempts.get(messageId) ?? 0;
    if (attempts >= this.MAX_ATTEMPTS) return;

    this.requestAttempts.set(messageId, attempts + 1);
    if (!environment.production) {
      console.log('[PeerMessageRecovery] Requesting resend for undecryptable message:', messageId, 'attempt:', attempts + 1);
    }
    this.socketSvc.requestMessageResend(conversationId, messageId);
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
