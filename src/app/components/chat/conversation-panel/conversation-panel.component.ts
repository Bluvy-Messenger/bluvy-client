import {
  Component, OnInit, OnDestroy, OnChanges, SimpleChanges,
  Input, ViewChild, ElementRef, ChangeDetectorRef, ChangeDetectionStrategy, inject,
} from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { firstValueFrom, Observable, Subscription } from 'rxjs';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { TypingIndicatorComponent } from '../typing-indicator/typing-indicator.component';
import { PresenceService } from '../../../core/presence/presence.service';
import { AuthService } from '../../../core/auth/auth.service';
import { ConversationsService } from '../../../core/conversation/conversations.service';
import type { ConversationListItem } from '../../../core/conversation/conversation.types';
import { MlsCoordinatorBase } from '../../../core/mls/coordinator/mls-coordinator.base';
import { SocketService } from '../../../core/infrastructure/socket.service';
import type { MessageNewPayload, WelcomeNewPayload } from '../../../core/infrastructure/socket.types';
import { MessageCacheService } from '../../../core/conversation/message-cache.service';
import type { CachedMessage, DisplayMessage, MessageReplyTo } from '../../../core/conversation/conversation.types';
import type { PlaceData } from '../../../core/place/place.types';
import { MessagePayloadHelper } from '../../../core/conversation/message-payload.helper';
import { SyncService } from '../../../core/sync/sync.service';
import { TypingService } from '../../../core/typing/typing.service';
import { ReceiptsService } from '../../../core/receipts/receipts.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector:    'app-conversation-panel',
  templateUrl: './conversation-panel.component.html',
  styleUrls:   ['./conversation-panel.component.scss'],
  standalone:  true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AsyncPipe,
    AvatarComponent,
    MessageBubbleComponent, MessageComposerComponent, TypingIndicatorComponent,
  ],
})
export class ConversationPanelComponent implements OnInit, OnDestroy, OnChanges {
  @Input() conversationId = '';

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef<HTMLDivElement>;

  private authSvc         = inject(AuthService);
  private convSvc         = inject(ConversationsService);
  private coordinator     = inject(MlsCoordinatorBase);
  private socketSvc       = inject(SocketService);
  private cdr             = inject(ChangeDetectorRef);
  private messageCacheSvc = inject(MessageCacheService);
  private syncSvc         = inject(SyncService);
  private typingSvc       = inject(TypingService);
  private receiptsSvc     = inject(ReceiptsService);

  readonly presenceSvc = inject(PresenceService);

  conversation:    ConversationListItem | null = null;
  displayMessages: DisplayMessage[] = [];
  replyingTo:      MessageReplyTo | null = null;
  loading          = false;
  sending          = false;
  error            = '';
  mlsGroupReady    = true;
  reestablishing   = false;
  typingUsers$!:   Observable<string[]>;

  get receiptStatusForLast(): 'read' | 'delivered' | 'sent' {
    if (this.isLastMessageRead) return 'read';
    if (this.isLastMessageDelivered) return 'delivered';
    return 'sent';
  }

  get isLastMessageRead(): boolean {
    const lastSent = this.lastSentMessageId;
    if (!lastSent) return false;
    const partnerDid = this.conversation?.participant.did;
    if (!partnerDid) return false;
    return this.receiptsSvc.isReadByPartner(this.conversationId, lastSent, partnerDid);
  }

  get isLastMessageDelivered(): boolean {
    const lastSent = this.lastSentMessageId;
    if (!lastSent) return false;
    return this.receiptsSvc.isDeliveredToPartner(this.conversationId, lastSent);
  }

  get lastSentMessageId(): string | null {
    for (let i = this.displayMessages.length - 1; i >= 0; i--) {
      const m = this.displayMessages[i]!;
      if (m.isMine && !m.pending) return m.id;
    }
    return null;
  }

  private subs              = new Subscription();
  private knownIds          = new Set<string>();
  private ensureGroupAbort: AbortController | null = null;

  ngOnInit(): void {
    if (this.conversationId) void this.init();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] && !changes['conversationId'].firstChange) {
      this.reset();
      void this.init();
    }
  }

  ngOnDestroy(): void {
    this.typingSvc.stopTyping(this.conversationId);
    this.markReadIfVisible();
    this.ensureGroupAbort?.abort();
    this.ensureGroupAbort = null;
    this.subs.unsubscribe();
  }

  getDateSeparator(index: number): string | null {
    const msg = this.displayMessages[index];
    if (!msg) return null;
    if (index === 0) return this.dateLabel(msg.createdAt);
    const prev = this.displayMessages[index - 1];
    if (!prev) return null;
    const d1 = new Date(msg.createdAt).toDateString();
    const d2 = new Date(prev.createdAt).toDateString();
    return d1 !== d2 ? this.dateLabel(msg.createdAt) : null;
  }

  private dateLabel(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  async sendMessage(text: string): Promise<void> {
    if (!text || this.sending) return;

    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) { this.error = 'Not authenticated.'; return; }

    const participantDid = this.conversation?.participant.did;
    if (!participantDid) { this.error = 'Conversation not loaded.'; return; }

    const activeReplyTo = this.replyingTo;
    this.sending = true;
    const pendingId = `pending-${Date.now()}-${Math.random()}`;
    this.displayMessages.push({
      id: pendingId, displayText: text, isMine: true, createdAt: Date.now(), pending: true, replyTo: activeReplyTo ?? null,
    });
    this.scrollToBottom();

    try {
      if (!this.ensureGroupAbort || this.ensureGroupAbort.signal.aborted) {
        this.ensureGroupAbort = new AbortController();
      }
      const memberDids = this.conversation?.members?.map(m => m.did);
      await this.coordinator.ensureGroupReady(
        this.conversationId,
        participantDid,
        user,
        device,
        this.ensureGroupAbort.signal,
        undefined,
        memberDids,
      );
      const payloadText = MessagePayloadHelper.encodeChatMessage(text, activeReplyTo ?? undefined);
      const ciphertext   = await this.coordinator.encryptMessage(this.conversationId, payloadText, user, device);
      const serverMsg    = await this.socketSvc.sendMessage(this.conversationId, ciphertext);
      this.knownIds.add(serverMsg.id);

      const cached: CachedMessage = {
        id: serverMsg.id, conversationId: this.conversationId,
        senderDeviceId: device.id, senderDid: user.did, plaintext: payloadText,
        isMine: true, undecryptable: false, cacheVersion: 1, encryptionVersion: 1,
        deletedAt: null, createdAt: serverMsg.createdAt, cachedAt: Date.now(),
        replyTo: activeReplyTo,
      };
      await this.messageCacheSvc.store(cached);
      this.syncSvc.enqueue({
        messageId: serverMsg.id, conversationId: this.conversationId,
        plaintext: payloadText, createdAt: serverMsg.createdAt, senderDid: user.did,
      });

      this.replyingTo = null;
      const idx = this.displayMessages.findIndex(m => m.id === pendingId);
      if (idx !== -1) this.displayMessages[idx] = this.toDisplayMessage(cached);
      this.scrollToBottom();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!environment.production) console.error('[ConversationPanel] sendMessage failed:', err);
      const idx = this.displayMessages.findIndex(m => m.id === pendingId);
      if (idx !== -1) {
        this.displayMessages[idx] = {
          ...this.displayMessages[idx],
          pending: false,
          failed: true,
          rawText: text,
          replyTo: activeReplyTo,
        };
      }
      this.error = err instanceof Error ? err.message : 'Send failed.';
    } finally {
      this.sending = false;
    }
  }

  async sendPlace(place: PlaceData): Promise<void> {
    if (!place || this.sending) return;

    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) { this.error = 'Not authenticated.'; return; }

    const participantDid = this.conversation?.participant.did;
    if (!participantDid) { this.error = 'Conversation not loaded.'; return; }

    this.sending = true;
    const pendingId = `pending-${Date.now()}-${Math.random()}`;
    this.displayMessages.push({
      id: pendingId, displayText: `📍 ${place.name}`, isMine: true, createdAt: Date.now(), pending: true, replyTo: null, place,
    });
    this.scrollToBottom();

    try {
      if (!this.ensureGroupAbort || this.ensureGroupAbort.signal.aborted) {
        this.ensureGroupAbort = new AbortController();
      }
      const memberDids = this.conversation?.members?.map(m => m.did);
      await this.coordinator.ensureGroupReady(
        this.conversationId,
        participantDid,
        user,
        device,
        this.ensureGroupAbort.signal,
        undefined,
        memberDids,
      );
      const payloadText = MessagePayloadHelper.encodePlaceMessage(place);
      const ciphertext   = await this.coordinator.encryptMessage(this.conversationId, payloadText, user, device);
      const serverMsg    = await this.socketSvc.sendMessage(this.conversationId, ciphertext);
      this.knownIds.add(serverMsg.id);

      const cached: CachedMessage = {
        id: serverMsg.id, conversationId: this.conversationId,
        senderDeviceId: device.id, senderDid: user.did, plaintext: payloadText,
        isMine: true, undecryptable: false, cacheVersion: 1, encryptionVersion: 1,
        deletedAt: null, createdAt: serverMsg.createdAt, cachedAt: Date.now(),
        replyTo: null,
      };
      await this.messageCacheSvc.store(cached);
      this.syncSvc.enqueue({
        messageId: serverMsg.id, conversationId: this.conversationId,
        plaintext: payloadText, createdAt: serverMsg.createdAt, senderDid: user.did,
      });

      const idx = this.displayMessages.findIndex(m => m.id === pendingId);
      if (idx !== -1) this.displayMessages[idx] = this.toDisplayMessage(cached);
      this.scrollToBottom();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!environment.production) console.error('[ConversationPanel] sendPlace failed:', err);
      const idx = this.displayMessages.findIndex(m => m.id === pendingId);
      if (idx !== -1) {
        this.displayMessages[idx] = {
          ...this.displayMessages[idx],
          pending: false,
          failed: true,
          rawText: `📍 ${place.name}`,
          place,
        };
      }
      this.error = err instanceof Error ? err.message : 'Send failed.';
    } finally {
      this.sending = false;
    }
  }

  async retrySendMessage(failedMsg: DisplayMessage): Promise<void> {
    if (!failedMsg || this.sending) return;

    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) { this.error = 'Not authenticated.'; return; }

    const participantDid = this.conversation?.participant.did;
    if (!participantDid) { this.error = 'Conversation not loaded.'; return; }

    const text = failedMsg.rawText ?? failedMsg.displayText;
    if (!text) return;

    const activeReplyTo = failedMsg.replyTo;
    const msgId = failedMsg.id;
    const idx = this.displayMessages.findIndex(m => m.id === msgId);
    if (idx !== -1) {
      this.displayMessages[idx] = {
        ...this.displayMessages[idx],
        pending: true,
        failed: false,
      };
    }
    this.sending = true;
    this.error = '';
    this.cdr.detectChanges();

    try {
      if (!this.ensureGroupAbort || this.ensureGroupAbort.signal.aborted) {
        this.ensureGroupAbort = new AbortController();
      }
      const memberDids = this.conversation?.members?.map(m => m.did);
      // 1. Re-establish encryption (catch-up / heal)
      await this.coordinator.ensureGroupReady(
        this.conversationId,
        participantDid,
        user,
        device,
        this.ensureGroupAbort.signal,
        undefined,
        memberDids,
      );

      // 2. Encrypt with fresh valid key
      let payloadText: string;
      if (failedMsg.place) {
        payloadText = MessagePayloadHelper.encodePlaceMessage(failedMsg.place);
      } else {
        payloadText = MessagePayloadHelper.encodeChatMessage(text, activeReplyTo ?? undefined);
      }

      const ciphertext = await this.coordinator.encryptMessage(this.conversationId, payloadText, user, device);

      // 3. Send message via socket
      const serverMsg = await this.socketSvc.sendMessage(this.conversationId, ciphertext);
      this.knownIds.add(serverMsg.id);

      const cached: CachedMessage = {
        id:                serverMsg.id,
        conversationId:    this.conversationId,
        senderDeviceId:    device.id,
        senderDid:         user.did,
        plaintext:         payloadText,
        isMine:            true,
        undecryptable:     false,
        cacheVersion:      1,
        encryptionVersion: 1,
        deletedAt:         null,
        createdAt:         serverMsg.createdAt,
        cachedAt:          Date.now(),
        replyTo:           activeReplyTo,
      };
      await this.messageCacheSvc.store(cached);
      this.syncSvc.enqueue({
        messageId:      serverMsg.id,
        conversationId: this.conversationId,
        plaintext:      payloadText,
        createdAt:      serverMsg.createdAt,
        senderDid:      user.did,
      });

      const currentIdx = this.displayMessages.findIndex(m => m.id === msgId);
      if (currentIdx !== -1) {
        this.displayMessages[currentIdx] = this.toDisplayMessage(cached);
      }
      this.scrollToBottom();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!environment.production) console.error('[ConversationPanel] retrySendMessage failed:', err);
      const currentIdx = this.displayMessages.findIndex(m => m.id === msgId);
      if (currentIdx !== -1) {
        this.displayMessages[currentIdx] = {
          ...this.displayMessages[currentIdx],
          pending: false,
          failed: true,
        };
      }
      this.error = err instanceof Error ? err.message : 'Retry failed.';
    } finally {
      this.sending = false;
      this.cdr.detectChanges();
    }
  }


  async reestablishEncryption(): Promise<void> {
    const user           = this.authSvc.currentUser();
    const device         = this.authSvc.currentDevice();
    const participantDid = this.conversation?.participant.did;
    if (!user || !device || !participantDid) return;

    this.reestablishing = true;
    this.error          = '';
    try {
      const memberDids = this.conversation?.members?.map(m => m.did);
      await this.coordinator.clearConversationGroup(this.conversationId, user, device);
      await this.coordinator.ensureGroupReady(
        this.conversationId,
        participantDid,
        user,
        device,
        undefined,
        undefined,
        memberDids,
      );
      this.mlsGroupReady = true;
      await this.loadHistory();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Could not re-establish encryption.';
    } finally {
      this.reestablishing = false;
      this.cdr.detectChanges();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private reset(): void {
    this.subs.unsubscribe();
    this.subs            = new Subscription();
    this.knownIds        = new Set();
    this.conversation    = null;
    this.displayMessages = [];
    this.loading         = false;
    this.sending         = false;
    this.error           = '';
    this.mlsGroupReady   = true;
    this.reestablishing  = false;
    this.ensureGroupAbort?.abort();
    this.ensureGroupAbort = null;
  }

  private async init(): Promise<void> {
    this.typingUsers$ = this.typingSvc.typingUsers$(this.conversationId);
    this.subscribeToSocket();

    this.loading = true;
    try {
      this.conversation = await firstValueFrom(
        this.convSvc.getConversationById(this.conversationId),
      );

      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (user && device) {
        await this.messageCacheSvc.initialize(user.did, device.id);
        try {
          // Type-mechanical adaptation only (P1 fix): see conversation.page.ts
          // for the identical rationale -- preserves the exact prior boolean
          // meaning (any outcome other than 'none').
          const welcomeResult = await this.coordinator.fetchAndProcessPendingWelcome(this.conversationId, user, device);
          const hadWelcome = welcomeResult !== 'none';
          if (hadWelcome && this.syncSvc.isMbkAvailable()) await this.syncSvc.restore();
        } catch (err) { if (!environment.production) console.warn('[MLS] fetchAndProcessPendingWelcome failed:', err); }
        try {
          await this.coordinator.catchUpMissedCommits(this.conversationId, user, device);
        } catch (err) { if (!environment.production) console.warn('[MLS] catchUpMissedCommits failed:', err); }
      }

      await this.loadHistory();
      // Only show the "Restore encryption" button when the conversation has
      // explicitly transitioned to FAILED. An Empty state (e.g. a device that
      // has just been switched / not yet provisioned and is waiting for its
      // Welcome) is neither ready nor failed — the button must not appear for
      // it, since encryption will establish transparently on first send.
      // Conflating Empty with Failed here was the root cause of the button
      // reappearing every time the active device changed (multi-device bug).
      this.mlsGroupReady = !this.coordinator.isConversationFailed(this.conversationId);
      this.markReadIfVisible();
    } catch {
      this.error = 'Could not load conversation.';
    } finally {
      this.loading = false;
    }
  }

  private async loadHistory(): Promise<void> {
    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    const cacheResult = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
    this.displayMessages = this.processMessagesAndFilterReactions(cacheResult.messages);
    this.scrollToBottom();

    const page         = await firstValueFrom(this.convSvc.getMessages(this.conversationId));
    const allCachedIds = await this.messageCacheSvc.getAllIds(this.conversationId);
    console.log('[MLS:loadHistory] fetched page messages count:', page.data.length, 'cached count:', allCachedIds.size);

    let senderUpdated = false;
    for (const msg of page.data) {
      if (allCachedIds.has(msg.id) && msg.senderDid) {
        const changed = await this.messageCacheSvc.updateSenderDid(msg.id, msg.senderDid, msg.senderDid === user.did);
        if (changed) senderUpdated = true;
      }
    }
    if (senderUpdated) {
      const refreshed = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
      this.displayMessages = this.processMessagesAndFilterReactions(refreshed.messages);
      this.scrollToBottom();
    }

    // Retry messages already marked undecryptable (classified as a "permanent"
    // MLS error at the time, e.g. EpochTooOld) — the group may have healed
    // since (a pending Welcome processed after the first attempt), in which
    // case a fresh decrypt can now succeed. Never previously succeeded, so
    // this doesn't touch an already-consumed ratchet generation.
    const undecryptableCached = cacheResult.messages.filter(m => m.undecryptable && m.deletedAt === null);
    if (undecryptableCached.length > 0) {
      const serverMsgById = new Map(page.data.map(m => [m.id, m]));
      let anyHealed = false;
      for (const stale of undecryptableCached) {
        const serverMsg = serverMsgById.get(stale.id);
        if (!serverMsg) continue;
        const result = await this.coordinator.decryptMessage(
          this.conversationId, stale.id, stale.senderDid ?? user.did, stale.senderDeviceId,
          stale.isMine, stale.createdAt, serverMsg.ciphertext, user, device,
        );
        console.log('[MLS:loadHistory] retried undecryptable message:', stale.id, 'result:', result.state);
        if (result.state === 'plaintext') {
          const healed = { ...stale, plaintext: result.plaintext, undecryptable: false };
          await this.messageCacheSvc.store(healed);
          this.upsertDisplay(healed);
          if (!stale.isMine) {
            this.syncSvc.enqueue({
              messageId: stale.id, conversationId: this.conversationId, plaintext: result.plaintext,
              createdAt: stale.createdAt, senderDid: stale.senderDid ?? user.did,
            });
          }
          anyHealed = true;
        }
      }
      if (anyHealed) this.scrollToBottom();
    }

    const missing = page.data.filter(m => !allCachedIds.has(m.id) && !this.knownIds.has(m.id));
    console.log('[MLS:loadHistory] missing messages:', missing.map(m => m.id));
    for (const msg of page.data) this.knownIds.add(msg.id);
    if (missing.length === 0) return;

    const newMessages: CachedMessage[] = [];
    for (const msg of missing) {
      const isMine = msg.senderDid === user.did;
      const result = await this.coordinator.decryptMessage(
        this.conversationId, msg.id, msg.senderDid, msg.senderDeviceId,
        isMine, msg.createdAt, msg.ciphertext, user, device,
      );
      console.log('[MLS:loadHistory] decrypted missing message:', msg.id, 'isMine:', isMine, 'result:', result.state);
      if (result.state === 'pending_decrypt') continue;
      const plaintext    = result.state === 'plaintext' ? result.plaintext : '';
      const undecryptable = !isMine && result.state === 'undecryptable';
      const cached = this.buildCached(msg.id, msg.conversationId, msg.senderDeviceId, msg.senderDid, plaintext, isMine, undecryptable, msg.createdAt);
      await this.messageCacheSvc.store(cached);
      newMessages.push(cached);
      if (result.state === 'plaintext') {
        this.syncSvc.enqueue({ messageId: msg.id, conversationId: msg.conversationId, plaintext, createdAt: msg.createdAt, senderDid: msg.senderDid });
      }
    }

    if (newMessages.length > 0) {
      console.log('[MLS:loadHistory] displaying newMessages count:', newMessages.length);
      for (const m of newMessages) this.upsertDisplay(m);
      this.displayMessages.sort((a, b) => a.createdAt - b.createdAt);
      this.scrollToBottom();
    }
  }

  private markReadIfVisible(): void {
    // See conversation.page.ts's markReadIfVisible: spliced-in historical
    // messages carry a synthetic "spliced:<convId>:<originalId>" cache key,
    // never a real server-side message id -- sending one here makes the
    // backend's read-state check silently no-op, leaving the unread badge
    // stuck forever. Skip them and report the most recent genuine message.
    const lastFromOther = [...this.displayMessages]
      .filter(m => !m.isMine && !m.pending && !m.id.startsWith('spliced:'))
      .at(-1);
    if (lastFromOther) this.receiptsSvc.markConversationRead(this.conversationId, lastFromOther.id);
  }

  private subscribeToSocket(): void {
    this.subs.add(
      this.socketSvc.receiptUpdate$.subscribe(payload => {
        if (payload.conversationId !== this.conversationId) return;
        this.cdr.detectChanges();
      }),
    );

    this.subs.add(
      this.coordinator.pendingDecryptReplayed$.subscribe(async event => {
        if (event.conversationId !== this.conversationId) return;
        for (const msg of event.messages) {
          await this.handleIncomingDecryptedMessage(msg);
        }
        this.displayMessages.sort((a, b) => a.createdAt - b.createdAt);
        this.cdr.detectChanges();
        this.scrollToBottom();
      }),
    );

    this.subs.add(
      this.socketSvc.messageNew$.subscribe(async (msg: MessageNewPayload) => {
        if (msg.conversationId !== this.conversationId) return;
        if (this.knownIds.has(msg.id)) return;
        this.knownIds.add(msg.id);
        if (await this.messageCacheSvc.exists(msg.id)) return;

        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;

        const isMine = msg.senderDid === user.did;
        if (isMine && msg.senderDeviceId === device.id) return;

        const result = await this.coordinator.decryptMessage(
          this.conversationId, msg.id, msg.senderDid, msg.senderDeviceId,
          isMine, msg.createdAt, msg.ciphertext, user, device,
        );
        if (result.state === 'pending_decrypt') return;

        const undecryptable = !isMine && result.state === 'undecryptable';
        const plaintext     = result.state === 'plaintext' ? result.plaintext : '';
        const cached = this.buildCached(msg.id, msg.conversationId, msg.senderDeviceId, msg.senderDid, plaintext, isMine, undecryptable, msg.createdAt);
        
        if (result.state === 'plaintext') {
          this.syncSvc.enqueue({ messageId: msg.id, conversationId: msg.conversationId, plaintext, createdAt: msg.createdAt, senderDid: msg.senderDid });
        }

        if (!isMine) this.socketSvc.sendMessageDelivered(msg.conversationId, msg.id, msg.senderDid);
        await this.handleIncomingDecryptedMessage(cached);
      }),
    );

    this.subs.add(
      this.socketSvc.welcomeNew$.subscribe(async (payload: WelcomeNewPayload) => {
        if (payload.conversationId !== this.conversationId) return;
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        try {
          await this.coordinator.processWelcome(payload.id, payload.welcome, this.conversationId, user, device);
          if (this.syncSvc.isMbkAvailable()) await this.syncSvc.restore();
          this.mlsGroupReady = true;
          await this.loadHistory();
        } catch (err) { if (!environment.production) console.error('[MLS] processWelcome failed:', err); }
      }),
    );

    this.subs.add(
      this.socketSvc.reconnect$.subscribe(() => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        void this.coordinator.catchUpMissedCommits(this.conversationId, user, device)
          .catch(err => { if (!environment.production) console.warn('[MLS] catchUpMissedCommits on reconnect failed:', err); });
      }),
    );

    this.subs.add(
      this.coordinator.conversationFailed$.subscribe(event => {
        if (event.conversationId !== this.conversationId) return;
        this.mlsGroupReady = false;
        this.cdr.detectChanges();
      }),
    );
  }

  private toDisplayMessage(msg: CachedMessage): DisplayMessage {
    let displayText: string;
    let replyTo = msg.replyTo ?? null;
    let place: PlaceData | null = null;

    if (msg.deletedAt !== null) displayText = '[Deleted]';
    else if (msg.undecryptable) displayText = '[Encrypted]';
    else {
      const parsed = MessagePayloadHelper.parseMessagePayload(msg.plaintext);
      if (parsed.type === 'chat') {
        displayText = parsed.text || (msg.isMine ? '[Sent]' : '');
        if (!replyTo && parsed.replyTo) {
          replyTo = parsed.replyTo;
        }
      } else if (parsed.type === 'place') {
        displayText = `📍 ${parsed.place.name}`;
        place = parsed.place;
      } else if (parsed.type === 'reaction') {
        displayText = '';
      } else {
        displayText = msg.plaintext;
      }
    }

    return {
      id: msg.id,
      displayText,
      isMine: msg.isMine,
      createdAt: msg.createdAt,
      pending: false,
      senderDid: msg.senderDid,
      replyTo,
      reactions: msg.reactions,
      place,
    };
  }


  onReplyToMessage(msg: DisplayMessage): void {
    const handle = this.conversation?.participant.handle;
    const mediaMatch = msg.displayText ? msg.displayText.match(/https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp)/i) : null;
    this.replyingTo = {
      messageId: msg.id,
      senderDid: msg.senderDid || this.conversation?.participant.did || '',
      senderHandle: msg.isMine ? 'Vous' : (handle ? `@${handle}` : undefined),
      textSnippet: msg.displayText,
      mediaThumbnail: mediaMatch ? mediaMatch[0] : undefined,
    };
    this.cdr.detectChanges();
  }

  get currentUserId(): string {
    return this.authSvc.currentUser()?.did || '';
  }

  async onToggleReaction(msg: DisplayMessage, emoji: string): Promise<void> {
    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    const currentList = msg.reactions?.[emoji] ?? [];
    const hasReacted  = currentList.includes(user.did);
    const action      = hasReacted ? 'remove' : 'add';

    const updated = MessagePayloadHelper.applyReactionMutation(
      msg.reactions, user.did, emoji, action
    );
    msg.reactions = updated;

    const cached = await this.messageCacheSvc.getById(msg.id);
    if (cached) {
      cached.reactions = updated;
      await this.messageCacheSvc.store(cached);
    }
    this.cdr.detectChanges();

    const encoded = MessagePayloadHelper.encodeReactionMessage(msg.id, emoji, action);
    try {
      const participantDid = this.conversation?.participant.did;
      if (participantDid) {
        await this.coordinator.ensureGroupReady(this.conversationId, participantDid, user, device);
        const ciphertext = await this.coordinator.encryptMessage(this.conversationId, encoded, user, device);
        const serverMsg  = await this.socketSvc.sendMessage(this.conversationId, ciphertext);
        this.knownIds.add(serverMsg.id);

        const reactionCached: CachedMessage = {
          id:                serverMsg.id,
          conversationId:    this.conversationId,
          senderDeviceId:    device.id,
          senderDid:         user.did,
          plaintext:         encoded,
          isMine:            true,
          undecryptable:     false,
          cacheVersion:      1,
          encryptionVersion: 1,
          deletedAt:         null,
          createdAt:         serverMsg.createdAt,
          cachedAt:          Date.now(),
        };
        await this.messageCacheSvc.store(reactionCached);
      }
    } catch (err) {
      if (!environment.production) console.error('[ConversationPanel] send reaction failed:', err);
    }
  }

  onJumpToReply(targetMessageId: string): void {
    const el = document.getElementById('msg-' + targetMessageId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('bubble--highlight');
      setTimeout(() => el.classList.remove('bubble--highlight'), 1500);
    }
  }

  private processMessagesAndFilterReactions(cachedMessages: CachedMessage[]): DisplayMessage[] {
    const reactionMapByMsgId = new Map<string, Record<string, string[]>>();

    for (const m of cachedMessages) {
      if (m.plaintext) {
        const parsed = MessagePayloadHelper.parseMessagePayload(m.plaintext);
        if (parsed.type === 'reaction') {
          const { targetMessageId, emoji, action } = parsed.reaction;
          const senderDid = m.senderDid || '';
          const currentReactions = reactionMapByMsgId.get(targetMessageId) || {};
          const updated = MessagePayloadHelper.applyReactionMutation(currentReactions, senderDid, emoji, action);
          reactionMapByMsgId.set(targetMessageId, updated);
        }
      }
    }

    const displayList: DisplayMessage[] = [];
    for (const m of cachedMessages) {
      const parsed = MessagePayloadHelper.parseMessagePayload(m.plaintext);
      if (parsed.type === 'reaction') {
        continue;
      }

      const dm = this.toDisplayMessage(m);
      const mergedReactions = reactionMapByMsgId.get(m.id) || m.reactions;
      if (mergedReactions) {
        dm.reactions = mergedReactions;
      }
      displayList.push(dm);
    }

    return displayList;
  }

  private async handleIncomingDecryptedMessage(cachedMsg: CachedMessage): Promise<void> {
    await this.messageCacheSvc.store(cachedMsg);

    if (cachedMsg.plaintext) {
      const parsed = MessagePayloadHelper.parseMessagePayload(cachedMsg.plaintext);
      if (parsed.type === 'reaction') {
        const { targetMessageId, emoji, action } = parsed.reaction;
        const senderDid = cachedMsg.senderDid || '';

        const target = this.displayMessages.find(m => m.id === targetMessageId);
        if (target) {
          target.reactions = MessagePayloadHelper.applyReactionMutation(
            target.reactions, senderDid, emoji, action
          );
        }

        const cachedTarget = await this.messageCacheSvc.getById(targetMessageId);
        if (cachedTarget) {
          cachedTarget.reactions = MessagePayloadHelper.applyReactionMutation(
            cachedTarget.reactions, senderDid, emoji, action
          );
          await this.messageCacheSvc.store(cachedTarget);
        }

        if (!cachedMsg.isMine) {
          this.receiptsSvc.markConversationRead(this.conversationId, cachedMsg.id);
        } else {
          this.markReadIfVisible();
        }

        this.cdr.detectChanges();
        return;
      }
    }

    this.upsertDisplay(cachedMsg);
    this.markReadIfVisible();
    this.cdr.detectChanges();
    this.scrollToBottom();
  }

  private upsertDisplay(msg: CachedMessage): void {
    if (msg.plaintext) {
      const parsed = MessagePayloadHelper.parseMessagePayload(msg.plaintext);
      if (parsed.type === 'reaction') {
        return;
      }
    }
    const dm  = this.toDisplayMessage(msg);
    const idx = this.displayMessages.findIndex(m => m.id === dm.id);
    if (idx !== -1) this.displayMessages[idx] = dm;
    else this.displayMessages.push(dm);
  }

  private buildCached(
    id: string, conversationId: string, senderDeviceId: string, senderDid: string,
    plaintext: string, isMine: boolean, undecryptable: boolean, createdAt: number,
  ): CachedMessage {
    return {
      id, conversationId, senderDeviceId, senderDid, plaintext, isMine, undecryptable,
      cacheVersion: 1, encryptionVersion: 1, deletedAt: null, createdAt, cachedAt: Date.now(),
    };
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      const el = this.messagesContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }
}
