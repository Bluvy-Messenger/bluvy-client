import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ReceiptsService } from './receipts.service';
import { SocketService } from '../infrastructure/socket.service';
import { AuthService } from '../auth/auth.service';
import { ApiClientService } from '../infrastructure/api-client.service';

const ALICE_DID = 'did:plc:alice';
const BOB_DID   = 'did:plc:bob';
const CONV_ID   = 'conv-1';

function makeSubject<T>() { return new Subject<T>(); }

describe('ReceiptsService', () => {
  let svc: ReceiptsService;

  let messageNew$:       Subject<{ conversationId: string; senderDid: string }>;
  let receiptUpdate$:    Subject<{ conversationId: string; lastReadMessageId: string; readerDid: string }>;
  let receiptDelivered$: Subject<{ conversationId: string; messageId: string }>;
  let reconnect$:        Subject<void>;
  let sendConversationRead: jasmine.Spy;

  beforeEach(() => {
    messageNew$       = makeSubject();
    receiptUpdate$    = makeSubject();
    receiptDelivered$ = makeSubject();
    reconnect$        = makeSubject();
    sendConversationRead = jasmine.createSpy('sendConversationRead');

    TestBed.configureTestingModule({
      providers: [
        ReceiptsService,
        {
          provide: SocketService,
          useValue: {
            messageNew$,
            receiptUpdate$,
            receiptDelivered$,
            reconnect$,
            sendConversationRead,
          },
        },
        {
          provide: AuthService,
          useValue: { currentUser: () => ({ did: ALICE_DID }) },
        },
        {
          provide: ApiClientService,
          useValue: { get: () => Promise.resolve({ states: [] }) },
        },
      ],
    });

    svc = TestBed.inject(ReceiptsService);
  });

  // ── setUnreadCounts ──────────────────────────────────────────────────────────

  it('setUnreadCounts propagates to unreadCount$', fakeAsync(() => {
    let count = -1;
    svc.unreadCount$(CONV_ID).subscribe(v => { count = v; });
    svc.setUnreadCounts({ [CONV_ID]: 5 });
    tick();
    expect(count).toBe(5);
  }));

  it('totalUnread$ sums across conversations', fakeAsync(() => {
    let total = -1;
    svc.totalUnread$.subscribe(v => { total = v; });
    svc.setUnreadCounts({ 'conv-1': 3, 'conv-2': 2 });
    tick();
    expect(total).toBe(5);
  }));

  // ── messageNew$ → unread increment ──────────────────────────────────────────

  it('increments unread when another user sends a message', fakeAsync(() => {
    let count = -1;
    svc.unreadCount$(CONV_ID).subscribe(v => { count = v; });
    messageNew$.next({ conversationId: CONV_ID, senderDid: BOB_DID });
    tick();
    expect(count).toBe(1);
  }));

  it('does not increment unread for own messages', fakeAsync(() => {
    let count = -1;
    svc.unreadCount$(CONV_ID).subscribe(v => { count = v; });
    messageNew$.next({ conversationId: CONV_ID, senderDid: ALICE_DID });
    tick();
    expect(count).toBe(0);
  }));

  it('increments unread for each message from another user', fakeAsync(() => {
    let count = -1;
    svc.unreadCount$(CONV_ID).subscribe(v => { count = v; });
    messageNew$.next({ conversationId: CONV_ID, senderDid: BOB_DID });
    messageNew$.next({ conversationId: CONV_ID, senderDid: BOB_DID });
    tick();
    expect(count).toBe(2);
  }));

  // ── markConversationRead ─────────────────────────────────────────────────────

  it('markConversationRead resets unread to 0', fakeAsync(() => {
    let count = -1;
    svc.unreadCount$(CONV_ID).subscribe(v => { count = v; });
    svc.setUnreadCounts({ [CONV_ID]: 3 });
    tick();
    svc.markConversationRead(CONV_ID, 'msg-99');
    tick();
    expect(count).toBe(0);
  }));

  it('markConversationRead calls sendConversationRead', () => {
    svc.markConversationRead(CONV_ID, 'msg-42');
    expect(sendConversationRead).toHaveBeenCalledWith(CONV_ID, 'msg-42');
  });

  it('markConversationRead updates totalUnread$', fakeAsync(() => {
    let total = -1;
    svc.totalUnread$.subscribe(v => { total = v; });
    svc.setUnreadCounts({ [CONV_ID]: 4 });
    tick();
    svc.markConversationRead(CONV_ID, 'msg-x');
    tick();
    expect(total).toBe(0);
  }));

  // ── receiptUpdate$ → setCount(0) when self reads ────────────────────────────

  it('receiptUpdate$ resets own unread to 0', fakeAsync(() => {
    let count = -1;
    svc.unreadCount$(CONV_ID).subscribe(v => { count = v; });
    svc.setUnreadCounts({ [CONV_ID]: 7 });
    tick();
    receiptUpdate$.next({ conversationId: CONV_ID, lastReadMessageId: 'msg-z', readerDid: ALICE_DID });
    tick();
    expect(count).toBe(0);
  }));

  // ── receiptDelivered$ → isDeliveredToPartner ─────────────────────────────────

  it('isDeliveredToPartner returns false before receipt', () => {
    expect(svc.isDeliveredToPartner(CONV_ID, 'msg-1')).toBeFalse();
  });

  it('isDeliveredToPartner returns true after receipt:delivered', fakeAsync(() => {
    receiptDelivered$.next({ conversationId: CONV_ID, messageId: 'msg-1' });
    tick();
    expect(svc.isDeliveredToPartner(CONV_ID, 'msg-1')).toBeTrue();
  }));

  it('isDeliveredToPartner does not bleed across conversations', fakeAsync(() => {
    receiptDelivered$.next({ conversationId: 'conv-other', messageId: 'msg-1' });
    tick();
    expect(svc.isDeliveredToPartner(CONV_ID, 'msg-1')).toBeFalse();
  }));
});
