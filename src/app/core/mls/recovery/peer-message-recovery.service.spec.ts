import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { PeerMessageRecoveryService } from './peer-message-recovery.service';
import { SocketService } from '../../infrastructure/socket.service';
import { MessageCacheService } from '../../conversation/message-cache.service';
import { MlsCoordinatorBase } from '../coordinator/mls-coordinator.base';
import { AuthService } from '../../auth/auth.service';
import { ConversationsService } from '../../conversation/conversations.service';
import { SyncService } from '../../sync/sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('PeerMessageRecoveryService.requestResend budget (F5)', () => {
  let service: PeerMessageRecoveryService;
  let socket: any;
  const reconnect$ = new Subject<void>();

  beforeEach(() => {
    try { localStorage.removeItem('bluvy-resend-attempts'); } catch { /* ignore */ }

    socket = {
      messageResendRequested$: new Subject(),
      messageResent$:          new Subject(),
      reconnect$,
      requestMessageResend:    jasmine.createSpy('requestMessageResend'),
    };

    TestBed.configureTestingModule({
      providers: [
        PeerMessageRecoveryService,
        { provide: SocketService, useValue: socket },
        { provide: MessageCacheService, useValue: {} },
        { provide: MlsCoordinatorBase, useValue: {} },
        { provide: AuthService, useValue: { currentUser: () => null, currentDevice: () => null } },
        { provide: ConversationsService, useValue: {} },
        { provide: SyncService, useValue: {} },
      ],
    });
    service = TestBed.inject(PeerMessageRecoveryService);
  });

  it('stops after MAX_ATTEMPTS requests for the same message', () => {
    service.requestResend('conv-1', 'msg-1');
    service.requestResend('conv-1', 'msg-1');
    service.requestResend('conv-1', 'msg-1');
    service.requestResend('conv-1', 'msg-1'); // 4th -- over the cap

    expect(socket.requestMessageResend).toHaveBeenCalledTimes(3);
  });

  it('persists the attempt count to localStorage and honours a pre-existing one', () => {
    service.requestResend('conv-1', 'msg-1');
    const stored = JSON.parse(localStorage.getItem('bluvy-resend-attempts')!);
    expect(stored['msg-1'].n).toBe(1);

    // A fresh service (new TestBed) must load that count and only have 2 left.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        PeerMessageRecoveryService,
        { provide: SocketService, useValue: socket },
        { provide: MessageCacheService, useValue: {} },
        { provide: MlsCoordinatorBase, useValue: {} },
        { provide: AuthService, useValue: { currentUser: () => null, currentDevice: () => null } },
        { provide: ConversationsService, useValue: {} },
        { provide: SyncService, useValue: {} },
      ],
    });
    const reloaded = TestBed.inject(PeerMessageRecoveryService);
    reloaded.requestResend('conv-1', 'msg-1');
    reloaded.requestResend('conv-1', 'msg-1');
    reloaded.requestResend('conv-1', 'msg-1'); // over cap (1 persisted + 2 now)

    expect(socket.requestMessageResend).toHaveBeenCalledTimes(3);
  });

  it('resets the budget on reconnect', () => {
    service.requestResend('conv-1', 'msg-1');
    service.requestResend('conv-1', 'msg-1');
    service.requestResend('conv-1', 'msg-1');
    expect(socket.requestMessageResend).toHaveBeenCalledTimes(3);

    reconnect$.next();

    service.requestResend('conv-1', 'msg-1');
    expect(socket.requestMessageResend).toHaveBeenCalledTimes(4);
  });
});
