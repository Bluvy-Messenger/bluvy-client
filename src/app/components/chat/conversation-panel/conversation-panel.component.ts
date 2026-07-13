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
import type { CachedMessage, DisplayMessage } from '../../../core/conversation/conversation.types';
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

    this.sending = true;
    const pendingId = `pending-${Date.now()}-${Math.random()}`;
    this.displayMessages.push({
      id: pendingId, displayText: text, isMine: true, createdAt: Date.now(), pending: true,
    });
    this.scrollToBottom();

    try {
      if (!this.ensureGroupAbort || this.ensureGroupAbort.signal.aborted) {
        this.ensureGroupAbort = new AbortController();
      }
      await this.coordinator.ensureGroupReady(this.conversationId, participantDid, user, device, this.ensureGroupAbort.signal);
      const ciphertext = await this.coordinator.encryptMessage(this.conversationId, text, user, device);
      const serverMsg  = await this.socketSvc.sendMessage(this.conversationId, ciphertext);
      this.knownIds.add(serverMsg.id);

      const cached: CachedMessage = {
        id: serverMsg.id, conversationId: this.conversationId,
        senderDeviceId: device.id, senderDid: user.did, plaintext: text,
        isMine: true, undecryptable: false, cacheVersion: 1, encryptionVersion: 1,
        deletedAt: null, createdAt: serverMsg.createdAt, cachedAt: Date.now(),
      };
      await this.messageCacheSvc.store(cached);
      this.syncSvc.enqueue({
        messageId: serverMsg.id, conversationId: this.conversationId,
        plaintext: text, createdAt: serverMsg.createdAt, senderDid: user.did,
      });

      const idx = this.displayMessages.findIndex(m => m.id === pendingId);
      if (idx !== -1) this.displayMessages[idx] = this.toDisplayMessage(cached);
      this.scrollToBottom();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!environment.production) console.error('[ConversationPanel] sendMessage failed:', err);
      this.displayMessages = this.displayMessages.filter(m => m.id !== pendingId);
      this.error = err instanceof Error ? err.message : 'Send failed.';
    } finally {
      this.sending = false;
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
      await this.coordinator.clearConversationGroup(this.conversationId, user, device);
      await this.coordinator.ensureGroupReady(this.conversationId, participantDid, user, device);
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
          const hadWelcome = await this.coordinator.fetchAndProcessPendingWelcome(this.conversationId, user, device);
          if (hadWelcome && this.syncSvc.isMbkAvailable()) await this.syncSvc.restore();
        } catch (err) { if (!environment.production) console.warn('[MLS] fetchAndProcessPendingWelcome failed:', err); }
        try {
          await this.coordinator.catchUpMissedCommits(this.conversationId, user, device);
        } catch (err) { if (!environment.production) console.warn('[MLS] catchUpMissedCommits failed:', err); }
      }

      await this.loadHistory();
      this.markReadIfVisible();
    } catch {
      this.error = 'Could not load conversation.';
    } finally {
      this.loading = false;
    }
  }

  private async loadHistory(): Promise<void> {
    this.mlsGroupReady = true;
    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    const cacheResult = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
    this.displayMessages = cacheResult.messages.map(m => this.toDisplayMessage(m));
    this.scrollToBottom();

    const page         = await firstValueFrom(this.convSvc.getMessages(this.conversationId));
    const allCachedIds = await this.messageCacheSvc.getAllIds(this.conversationId);

    let senderUpdated = false;
    for (const msg of page.data) {
      if (allCachedIds.has(msg.id) && msg.senderDid) {
        const changed = await this.messageCacheSvc.updateSenderDid(msg.id, msg.senderDid, msg.senderDid === user.did);
        if (changed) senderUpdated = true;
      }
    }
    if (senderUpdated) {
      const refreshed = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
      this.displayMessages = refreshed.messages.map(m => this.toDisplayMessage(m));
      this.scrollToBottom();
    }

    const missing = page.data.filter(m => !allCachedIds.has(m.id) && !this.knownIds.has(m.id));
    for (const msg of page.data) this.knownIds.add(msg.id);
    if (missing.length === 0) return;

    const newMessages: CachedMessage[] = [];
    for (const msg of missing) {
      const isMine = msg.senderDid === user.did;
      const result = await this.coordinator.decryptMessage(
        this.conversationId, msg.id, msg.senderDid, msg.senderDeviceId,
        isMine, msg.createdAt, msg.ciphertext, user, device,
      );
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
      for (const m of newMessages) this.upsertDisplay(m);
      this.displayMessages.sort((a, b) => a.createdAt - b.createdAt);
      this.scrollToBottom();
    }
  }

  private markReadIfVisible(): void {
    const lastFromOther = [...this.displayMessages].filter(m => !m.isMine && !m.pending).at(-1);
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
      this.coordinator.pendingDecryptReplayed$.subscribe(event => {
        if (event.conversationId !== this.conversationId) return;
        for (const msg of event.messages) this.upsertDisplay(msg);
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
        await this.messageCacheSvc.store(cached);
        if (result.state === 'plaintext') {
          this.syncSvc.enqueue({ messageId: msg.id, conversationId: msg.conversationId, plaintext, createdAt: msg.createdAt, senderDid: msg.senderDid });
        }
        this.upsertDisplay(cached);
        this.markReadIfVisible();
        if (!isMine) this.socketSvc.sendMessageDelivered(msg.conversationId, msg.id, msg.senderDid);
        this.cdr.detectChanges();
        this.scrollToBottom();
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
  }

  private toDisplayMessage(msg: CachedMessage): DisplayMessage {
    let displayText: string;
    if (msg.deletedAt !== null)  displayText = '[Deleted]';
    else if (msg.undecryptable)  displayText = '[Encrypted]';
    else if (msg.isMine)         displayText = msg.plaintext || '[Sent]';
    else                         displayText = msg.plaintext;
    return { id: msg.id, displayText, isMine: msg.isMine, createdAt: msg.createdAt, pending: false };
  }

  private upsertDisplay(msg: CachedMessage): void {
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
