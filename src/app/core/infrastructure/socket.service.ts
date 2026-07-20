import { Injectable, NgZone, inject } from '@angular/core';
import { Subject, ReplaySubject, Observable, throttleTime, asyncScheduler } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { StorageService } from './storage.service';
import type {
  MessageNewPayload, WelcomeNewPayload, DeviceNewPayload, MlsCommitPayload,
  PresenceSnapshotPayload, PresenceUpdatePayload,
  TypingStartPayload, TypingStopPayload, ReceiptUpdatePayload, ReceiptDeliveredPayload,
  ConversationNewPayload, MlsRefillKeyPackagesPayload, DeviceRevokedPayload,
  SendAck,
} from './socket.types';
import { SOCKET_EVENTS } from './socket.constants';
import {
  validateMessageNewPayload,
  validateWelcomeNewPayload,
  validateDeviceNewPayload,
  validateMlsCommitPayload,
  validatePresenceSnapshotPayload,
  validatePresenceUpdatePayload,
  validateTypingStartPayload,
  validateTypingStopPayload,
  validateReceiptUpdatePayload,
  validateReceiptDeliveredPayload,
  validateConversationNewPayload,
  validateMlsRefillKeyPackagesPayload,
  validateDeviceRevokedPayload,
} from './socket.validator';

export type {
  MessageNewPayload, WelcomeNewPayload, DeviceNewPayload, MlsCommitPayload,
  PresenceSnapshotPayload, PresenceUpdatePayload,
  TypingStartPayload, TypingStopPayload, ReceiptUpdatePayload, ReceiptDeliveredPayload,
  ConversationNewPayload, MlsRefillKeyPackagesPayload, DeviceRevokedPayload,
} from './socket.types';

@Injectable({ providedIn: 'root' })
export class SocketService {
  private zone    = inject(NgZone);
  private storage = inject(StorageService);

  private socket: Socket | null = null;
  private _hasConnectedOnce = false;

  private readonly _messageNew          = new Subject<MessageNewPayload>();
  private readonly _welcomeNew          = new Subject<WelcomeNewPayload>();
  private readonly _deviceNew           = new Subject<DeviceNewPayload>();
  private readonly _mlsCommit           = new Subject<MlsCommitPayload>();
  private readonly _presenceSnapshot    = new ReplaySubject<PresenceSnapshotPayload>(1);
  private readonly _presenceUpdate      = new Subject<PresenceUpdatePayload>();
  private readonly _typingStart         = new Subject<TypingStartPayload>();
  private readonly _typingStop          = new Subject<TypingStopPayload>();
  private readonly _receiptUpdate       = new Subject<ReceiptUpdatePayload>();
  private readonly _receiptDelivered    = new Subject<ReceiptDeliveredPayload>();
  private readonly _conversationNew     = new Subject<ConversationNewPayload>();
  private readonly _reconnect           = new Subject<void>();
  private readonly _connectError        = new Subject<Error>();
  private readonly _mlsRefillKeyPackages = new Subject<MlsRefillKeyPackagesPayload>();
  private readonly _deviceRevoked       = new Subject<DeviceRevokedPayload>();

  readonly messageNew$: Observable<MessageNewPayload> = this._messageNew.asObservable().pipe(
    throttleTime(100, asyncScheduler, { leading: true, trailing: true }),
  );
  readonly welcomeNew$:          Observable<WelcomeNewPayload>          = this._welcomeNew.asObservable();
  readonly deviceNew$:           Observable<DeviceNewPayload>           = this._deviceNew.asObservable();
  readonly mlsCommit$:           Observable<MlsCommitPayload>           = this._mlsCommit.asObservable();
  readonly presenceSnapshot$:    Observable<PresenceSnapshotPayload>    = this._presenceSnapshot.asObservable();
  readonly presenceUpdate$:      Observable<PresenceUpdatePayload>      = this._presenceUpdate.asObservable();
  readonly typingStart$:         Observable<TypingStartPayload>         = this._typingStart.asObservable();
  readonly typingStop$:          Observable<TypingStopPayload>          = this._typingStop.asObservable();
  readonly receiptUpdate$:       Observable<ReceiptUpdatePayload>       = this._receiptUpdate.asObservable();
  readonly receiptDelivered$:    Observable<ReceiptDeliveredPayload>    = this._receiptDelivered.asObservable();
  readonly conversationNew$:     Observable<ConversationNewPayload>     = this._conversationNew.asObservable();
  readonly reconnect$:           Observable<void>                       = this._reconnect.asObservable();
  readonly connectError$:        Observable<Error>                      = this._connectError.asObservable();
  readonly mlsRefillKeyPackages$: Observable<MlsRefillKeyPackagesPayload> = this._mlsRefillKeyPackages.asObservable();
  readonly deviceRevoked$:       Observable<DeviceRevokedPayload>       = this._deviceRevoked.asObservable();

  connect(): void {
    if (this.socket) return;

    this.socket = this.zone.runOutsideAngular(() =>
      io(environment.socketUrl, {
        auth: (cb: (data: Record<string, string>) => void) => {
          void this.storage.getAccessToken().then(token => cb({ token: token ?? '' }));
        },
        transports:           ['websocket', 'polling'],
        reconnectionDelay:    1000,
        reconnectionDelayMax: 5000,
      }),
    );

    this.socket.on(SOCKET_EVENTS.CONNECT, () => {
      const isReconnect = this._hasConnectedOnce;
      this._hasConnectedOnce = true;
      if (isReconnect) {
        this.zone.run(() => this._reconnect.next());
      }
    });

    this.socket.on(SOCKET_EVENTS.CONNECT_ERROR, (err: Error) => {
      this.zone.run(() => this._connectError.next(err));
    });

    this.socket.on(SOCKET_EVENTS.MESSAGE_NEW, (raw: MessageNewPayload) => {
      let data: MessageNewPayload;
      try { data = validateMessageNewPayload(raw); } catch { return; }
      this.zone.run(() => this._messageNew.next(data));
    });

    this.socket.on(SOCKET_EVENTS.WELCOME_NEW, (raw: WelcomeNewPayload) => {
      let data: WelcomeNewPayload;
      try { data = validateWelcomeNewPayload(raw); } catch { return; }
      this.zone.run(() => this._welcomeNew.next(data));
    });

    this.socket.on(SOCKET_EVENTS.DEVICE_NEW, (raw: DeviceNewPayload) => {
      let data: DeviceNewPayload;
      try { data = validateDeviceNewPayload(raw); } catch { return; }
      this.zone.run(() => this._deviceNew.next(data));
    });

    this.socket.on(SOCKET_EVENTS.MLS_COMMIT, (raw: MlsCommitPayload) => {
      let data: MlsCommitPayload;
      try { data = validateMlsCommitPayload(raw); } catch { return; }
      this.zone.run(() => this._mlsCommit.next(data));
    });

    this.socket.on(SOCKET_EVENTS.PRESENCE_SNAPSHOT, (raw: PresenceSnapshotPayload) => {
      let data: PresenceSnapshotPayload;
      try { data = validatePresenceSnapshotPayload(raw); } catch { return; }
      this.zone.run(() => this._presenceSnapshot.next(data));
    });

    this.socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, (raw: PresenceUpdatePayload) => {
      let data: PresenceUpdatePayload;
      try { data = validatePresenceUpdatePayload(raw); } catch { return; }
      this.zone.run(() => this._presenceUpdate.next(data));
    });

    this.socket.on(SOCKET_EVENTS.TYPING_START, (raw: TypingStartPayload) => {
      let data: TypingStartPayload;
      try { data = validateTypingStartPayload(raw); } catch { return; }
      this.zone.run(() => this._typingStart.next(data));
    });

    this.socket.on(SOCKET_EVENTS.TYPING_STOP, (raw: TypingStopPayload) => {
      let data: TypingStopPayload;
      try { data = validateTypingStopPayload(raw); } catch { return; }
      this.zone.run(() => this._typingStop.next(data));
    });

    this.socket.on(SOCKET_EVENTS.RECEIPT_UPDATE, (raw: ReceiptUpdatePayload) => {
      let data: ReceiptUpdatePayload;
      try { data = validateReceiptUpdatePayload(raw); } catch { return; }
      this.zone.run(() => this._receiptUpdate.next(data));
    });

    this.socket.on(SOCKET_EVENTS.RECEIPT_DELIVERED, (raw: ReceiptDeliveredPayload) => {
      let data: ReceiptDeliveredPayload;
      try { data = validateReceiptDeliveredPayload(raw); } catch { return; }
      this.zone.run(() => this._receiptDelivered.next(data));
    });

    this.socket.on(SOCKET_EVENTS.CONVERSATION_NEW, (raw: ConversationNewPayload) => {
      let data: ConversationNewPayload;
      try { data = validateConversationNewPayload(raw); } catch { return; }
      this.zone.run(() => this._conversationNew.next(data));
    });

    this.socket.on(SOCKET_EVENTS.MLS_REFILL_KEY_PACKAGES, (raw: MlsRefillKeyPackagesPayload) => {
      let data: MlsRefillKeyPackagesPayload;
      try { data = validateMlsRefillKeyPackagesPayload(raw); } catch { return; }
      this.zone.run(() => this._mlsRefillKeyPackages.next(data));
    });

    this.socket.on(SOCKET_EVENTS.DEVICE_REVOKED, (raw: DeviceRevokedPayload) => {
      let data: DeviceRevokedPayload;
      try { data = validateDeviceRevokedPayload(raw); } catch { return; }
      this.zone.run(() => this._deviceRevoked.next(data));
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this._hasConnectedOnce = false;
  }

  sendTypingStart(conversationId: string): void {
    this.socket?.emit(SOCKET_EVENTS.TYPING_START, { conversationId });
  }

  sendTypingStop(conversationId: string): void {
    this.socket?.emit(SOCKET_EVENTS.TYPING_STOP, { conversationId });
  }

  sendConversationRead(conversationId: string, lastMessageId: string): void {
    this.socket?.emit(SOCKET_EVENTS.CONVERSATION_READ, { conversationId, lastMessageId });
  }

  sendMessageDelivered(conversationId: string, messageId: string, senderDid: string): void {
    this.socket?.emit(SOCKET_EVENTS.MESSAGE_DELIVERED, { conversationId, messageId, senderDid });
  }

  // Sends a message and returns the server-confirmed message via the ack.
  sendMessage(conversationId: string, ciphertext: string): Promise<MessageNewPayload> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }

      this.socket.emit(
        SOCKET_EVENTS.MESSAGE_SEND,
        { conversationId, ciphertext },
        (ack: SendAck) => {
          if (ack.ok) resolve(ack.message);
          else reject(new Error(`${ack.code}: ${ack.message}`));
        },
      );
    });
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}
