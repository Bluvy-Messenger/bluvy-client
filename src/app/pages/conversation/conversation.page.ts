import {
  Component, OnDestroy, ViewChild, ChangeDetectorRef, inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { firstValueFrom, Observable, Subscription } from 'rxjs';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonFooter,
  IonText,
  IonButtons, IonBackButton, IonButton,
  IonPopover, IonIcon,
} from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { MessageBubbleComponent } from '../../components/chat/message-bubble/message-bubble.component';
import { MessageComposerComponent } from '../../components/chat/message-composer/message-composer.component';
import { TypingIndicatorComponent } from '../../components/chat/typing-indicator/typing-indicator.component';
import { PresenceService } from '../../core/presence/presence.service';
import { AuthService } from '../../core/auth/auth.service';
import { ConversationsService } from '../../core/conversation/conversations.service';
import type { ConversationListItem } from '../../core/conversation/conversation.types';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { SocketService } from '../../core/infrastructure/socket.service';
import type { MessageNewPayload, WelcomeNewPayload } from '../../core/infrastructure/socket.types';
import { MessageCacheService } from '../../core/conversation/message-cache.service';
import type { CachedMessage, DisplayMessage } from '../../core/conversation/conversation.types';
import { SyncService } from '../../core/sync/sync.service';
import { TypingService } from '../../core/typing/typing.service';
import { ReceiptsService } from '../../core/receipts/receipts.service';
import { environment } from '../../../environments/environment';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector:    'app-conversation',
  templateUrl: './conversation.page.html',
  styleUrls:   ['./conversation.page.scss'],
  standalone:  true,
  imports: [
    AsyncPipe,
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonFooter,
    IonText,
    IonButtons, IonBackButton, IonButton,
    IonPopover, IonIcon,
    AvatarComponent,
    MessageBubbleComponent, MessageComposerComponent, TypingIndicatorComponent,
    TranslatePipe,
  ],
})
export class ConversationPage implements OnDestroy {
  @ViewChild(IonContent) private ionContent!: IonContent;
  @ViewChild('optionsPopover') optionsPopover!: IonPopover;

  protected readonly environment = environment;

  private route           = inject(ActivatedRoute);
  private router          = inject(Router);
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
  private i18n         = inject(TranslationService);

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

  protected conversationId  = '';
  private subs              = new Subscription();
  private knownIds          = new Set<string>();
  private ensureGroupAbort: AbortController | null = null;

  // Ionic keeps this page instance alive in its navigation stack instead of
  // destroying it on "back" (see stack-controller in @ionic/angular) — so
  // ngOnInit/ngOnDestroy only fire once, on the very first visit. Socket
  // subscriptions are therefore opened in ionViewWillEnter and closed in
  // ionViewWillLeave, so they don't leak (and don't double-fire) across
  // repeated visits to a cached conversation instance.
  async ionViewWillEnter(): Promise<void> {
    this.conversationId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.conversationId) {
      this.error = 'Invalid conversation.';
      return;
    }
    this.typingUsers$ = this.typingSvc.typingUsers$(this.conversationId);

    // Reset for the (possibly different) conversation this page instance is now
    // showing — before the MLS catch-up calls below, so a FAILED detected during
    // THIS visit isn't immediately clobbered back to true by loadHistory().
    this.mlsGroupReady = true;

    this.subs = new Subscription();
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
          if (hadWelcome && this.syncSvc.isMbkAvailable()) {
            await this.syncSvc.restore();
          }
        } catch (err) {
          if (!environment.production) console.warn('[MLS] fetchAndProcessPendingWelcome failed:', err);
        }
        try {
          await this.coordinator.catchUpMissedCommits(this.conversationId, user, device);
        } catch (err) {
          if (!environment.production) console.warn('[MLS] catchUpMissedCommits failed:', err);
        }
      }

      await this.loadHistory();
      this.markReadIfVisible();
    } catch {
      this.error = 'Could not load conversation.';
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
      this.scrollToBottom();
    }
  }

  ionViewDidEnter(): void {
    this.scrollToBottom();
  }

  ionViewWillLeave(): void {
    this.typingSvc.stopTyping(this.conversationId);
    this.markReadIfVisible();
    this.subs.unsubscribe();
  }

  // Defensive: only reached if the page is truly destroyed (e.g. Ionic evicts
  // it from the stack). ionViewWillLeave already unsubscribes on every visit,
  // so this is a no-op in the common case.
  ngOnDestroy(): void {
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
    if (d.toDateString() === today.toDateString()) return this.i18n.t('conversation.today');
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return this.i18n.t('conversation.yesterday');
    return d.toLocaleDateString(this.i18n.locale === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  async sendMessage(text: string): Promise<void> {
    if (!text || this.sending) return;

    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) {
      this.error = 'Not authenticated.';
      return;
    }

    const participantDid = this.conversation?.participant.did;
    if (!participantDid) {
      this.error = 'Conversation not loaded.';
      return;
    }

    this.sending = true;

    const pendingId = `pending-${Date.now()}-${Math.random()}`;
    const now       = Date.now();
    this.displayMessages.push({
      id:          pendingId,
      displayText: text,
      isMine:      true,
      createdAt:   now,
      pending:     true,
    });
    this.scrollToBottom();

    try {
      if (!this.ensureGroupAbort || this.ensureGroupAbort.signal.aborted) {
        this.ensureGroupAbort = new AbortController();
      }
      await this.coordinator.ensureGroupReady(this.conversationId, participantDid, user, device, this.ensureGroupAbort.signal);
      const ciphertext = await this.coordinator.encryptMessage(this.conversationId, text, user, device);
      const serverMsg  = await this.socketSvc.sendMessage(this.conversationId, ciphertext);
      // Mark as known immediately so the socket handler skips it if it fires before cache write.
      this.knownIds.add(serverMsg.id);

      const cached: CachedMessage = {
        id:                serverMsg.id,
        conversationId:    this.conversationId,
        senderDeviceId:    device.id,
        senderDid:         user.did,
        plaintext:         text,
        isMine:            true,
        undecryptable:     false,
        cacheVersion:      1,
        encryptionVersion: 1,
        deletedAt:         null,
        createdAt:         serverMsg.createdAt,
        cachedAt:          Date.now(),
      };
      await this.messageCacheSvc.store(cached);
      this.syncSvc.enqueue({
        messageId:      serverMsg.id,
        conversationId: this.conversationId,
        plaintext:      text,
        createdAt:      serverMsg.createdAt,
        senderDid:      user.did,
      });

      const idx = this.displayMessages.findIndex(m => m.id === pendingId);
      if (idx !== -1) {
        this.displayMessages[idx] = this.toDisplayMessage(cached);
      }
      this.scrollToBottom();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!environment.production) console.error('[ConversationPage] sendMessage failed:', err);
      this.displayMessages = this.displayMessages.filter(m => m.id !== pendingId);
      this.error           = err instanceof Error ? err.message : 'Send failed.';
    } finally {
      this.sending = false;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async loadHistory(): Promise<void> {
    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    // [1] Show cached messages immediately — no MLS calls.
    const cacheResult = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
    this.displayMessages = cacheResult.messages.map(m => this.toDisplayMessage(m));
    this.scrollToBottom();

    // [2] Fetch server page for gap detection, sender info repair, and placeholder recovery.
    const page = await firstValueFrom(this.convSvc.getMessages(this.conversationId));

    // [3] Get all cached IDs (not just displayed 50) for accurate gap detection.
    const allCachedIds = await this.messageCacheSvc.getAllIds(this.conversationId);

    // [4] Repair sender info for cached messages that predate migration 0004.
    // senderDid is now returned by the server — update any cached record that lacks it.
    let senderUpdated = false;
    for (const msg of page.data) {
      if (allCachedIds.has(msg.id) && msg.senderDid) {
        const changed = await this.messageCacheSvc.updateSenderDid(
          msg.id,
          msg.senderDid,
          msg.senderDid === user.did,
        );
        if (changed) senderUpdated = true;
      }
    }
    if (senderUpdated) {
      const refreshed = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
      this.displayMessages = refreshed.messages.map(m => this.toDisplayMessage(m));
      this.scrollToBottom();
    }

    // [4.5] Attempt to recover orphaned own-device placeholders AND messages
    // already marked undecryptable. Own-device orphans are cached without
    // plaintext because the socket handler previously did not attempt MLS
    // decryption for messages from other own devices. Messages already marked
    // undecryptable were classified as a "permanent" MLS error (e.g.
    // EpochTooOld) at the time — but that classification only means "not
    // retryable right now", not "provably impossible forever": if the group
    // has since healed (a pending Welcome was processed after this message's
    // first attempt), a fresh decrypt can succeed. Neither category was ever
    // consumed successfully, so retrying doesn't touch an already-used ratchet
    // generation the way re-decrypting a *successful* past message would.
    const orphans = cacheResult.messages.filter(
      m => m.deletedAt === null && (
        (m.isMine && m.plaintext === '' && !m.undecryptable) ||
        m.undecryptable
      ),
    );
    if (orphans.length > 0) {
      const serverMsgById = new Map(page.data.map(m => [m.id, m]));
      let anyFixed = false;
      for (const orphan of orphans) {
        const serverMsg = serverMsgById.get(orphan.id);
        if (!serverMsg) continue;
        const result = await this.coordinator.decryptMessage(
          this.conversationId,
          orphan.id,
          orphan.senderDid ?? user.did,
          orphan.senderDeviceId,
          orphan.isMine,
          orphan.createdAt,
          serverMsg.ciphertext,
          user,
          device,
        );
        if (result.state === 'plaintext') {
          await this.messageCacheSvc.store({ ...orphan, plaintext: result.plaintext, undecryptable: false });
          this.syncSvc.enqueue({
            messageId:      orphan.id,
            conversationId: this.conversationId,
            plaintext:      result.plaintext,
            createdAt:      orphan.createdAt,
            senderDid:      orphan.senderDid ?? user.did,
          });
          anyFixed = true;
        }
        // pending_decrypt or still undecryptable: placeholder stays unchanged.
      }
      if (anyFixed) {
        const refreshed = await this.messageCacheSvc.getMessages(this.conversationId, 50, true);
        this.displayMessages = refreshed.messages.map(m => this.toDisplayMessage(m));
        this.scrollToBottom();
      }
    }

    // [5] Missing = on server but not in cache and not already being handled by socket.
    // Messages at/before the last local-history-clear watermark are excluded: they were
    // already decrypted once before being cleared, so their MLS ratchet generation is
    // already consumed and re-decrypting them would fail with EpochMismatch.
    const clearedAt = this.messageCacheSvc.getHistoryClearedAt(this.conversationId);
    const missing = page.data.filter(m =>
      !allCachedIds.has(m.id) &&
      !this.knownIds.has(m.id) &&
      (clearedAt === null || m.createdAt > clearedAt),
    );

    // [6] Mark all server IDs as known after computing missing so socket won't reprocess them.
    for (const msg of page.data) {
      this.knownIds.add(msg.id);
    }

    if (missing.length === 0) return;

    // [7] Process missing in ASC order (getMessages guarantees ASC — required for ratchet).
    const newMessages: CachedMessage[] = [];
    for (const msg of missing) {
      const isMine = msg.senderDid === user.did;

      if (isMine) {
        // Attempt decryption before storing a placeholder — recovers content when the
        // MLS ratchet hasn't advanced past this message (e.g. very recent gap-fill).
        const result = await this.coordinator.decryptMessage(
          this.conversationId,
          msg.id,
          msg.senderDid,
          msg.senderDeviceId,
          true,
          msg.createdAt,
          msg.ciphertext,
          user,
          device,
        );
        const plaintext = result.state === 'plaintext' ? result.plaintext : '';
        const cached = this.buildCached(msg.id, msg.conversationId, msg.senderDeviceId, msg.senderDid, plaintext, true, false, msg.createdAt);
        await this.messageCacheSvc.store(cached);
        newMessages.push(cached);
        if (result.state === 'plaintext') {
          this.syncSvc.enqueue({
            messageId:      msg.id,
            conversationId: msg.conversationId,
            plaintext,
            createdAt:      msg.createdAt,
            senderDid:      msg.senderDid,
          });
        }
      } else {
        const result = await this.coordinator.decryptMessage(
          this.conversationId,
          msg.id,
          msg.senderDid,
          msg.senderDeviceId,
          false,
          msg.createdAt,
          msg.ciphertext,
          user,
          device,
        );

        if (result.state === 'pending_decrypt') {
          // Coordinator has queued this message for replay after GroupState becomes READY.
          // Do not write to cache — writing would prevent replay from re-decrypting it.
          continue;
        }

        const cached = this.buildCached(msg.id, msg.conversationId, msg.senderDeviceId, msg.senderDid, result.plaintext, false, result.state === 'undecryptable', msg.createdAt);
        await this.messageCacheSvc.store(cached);
        newMessages.push(cached);
        if (result.state === 'plaintext') {
          this.syncSvc.enqueue({
            messageId:      msg.id,
            conversationId: msg.conversationId,
            plaintext:      result.plaintext,
            createdAt:      msg.createdAt,
            senderDid:      msg.senderDid,
          });
        }
      }
    }

    // [8] Merge gap messages using upsert to prevent duplicates (e.g. socket race).
    if (newMessages.length > 0) {
      for (const m of newMessages) {
        this.upsertDisplay(m);
      }
      this.displayMessages.sort((a, b) => a.createdAt - b.createdAt);
      this.scrollToBottom();
    }
  }

  get lastSentMessageId(): string | null {
    for (let i = this.displayMessages.length - 1; i >= 0; i--) {
      const m = this.displayMessages[i]!;
      if (m.isMine && !m.pending) return m.id;
    }
    return null;
  }

  getMessagePosition(index: number): 'first' | 'middle' | 'last' | 'single' {
    const current = this.displayMessages[index];
    if (!current) return 'single';

    const prev = this.displayMessages[index - 1];
    const next = this.displayMessages[index + 1];

    const isPrevSame = prev && prev.isMine === current.isMine;
    const isNextSame = next && next.isMine === current.isMine;

    if (isPrevSame && isNextSame) return 'middle';
    if (isPrevSame) return 'last';
    if (isNextSame) return 'first';
    return 'single';
  }

  openPopover(event: Event): void {
    if (this.optionsPopover) {
      this.optionsPopover.event = event;
      void this.optionsPopover.present();
    }
  }

  viewProfile(): void {
    const partnerDid = this.conversation?.participant.did;
    if (partnerDid) {
      void this.router.navigate([ROUTES.contact(partnerDid)]);
    }
  }

  isMuted(): boolean {
    return localStorage.getItem('muted_conv_' + this.conversationId) === 'true';
  }

  toggleMute(): void {
    if (this.isMuted()) {
      localStorage.removeItem('muted_conv_' + this.conversationId);
    } else {
      localStorage.setItem('muted_conv_' + this.conversationId, 'true');
    }
  }

  async clearLocalHistoryPrompt(): Promise<void> {
    const confirmClear = confirm(this.i18n.t('conversation.confirm_clear_history'));
    if (!confirmClear) return;

    const user = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    await this.messageCacheSvc.clearConversation(this.conversationId);
    this.displayMessages = [];
    this.cdr.markForCheck();
  }

  async deleteConversationPrompt(): Promise<void> {
    const confirmDelete = confirm(this.i18n.t('conversation.confirm_delete'));
    if (!confirmDelete) return;

    try {
      await this.messageCacheSvc.clearConversation(this.conversationId);
      await firstValueFrom(this.convSvc.deleteConversation(this.conversationId));
      void this.router.navigate([ROUTES.conversations]);
    } catch (e) {
      console.error('Failed to delete conversation:', e);
      alert('Could not delete conversation from server. Please try again.');
    }
  }

  async toggleArchive(): Promise<void> {
    if (!this.conversation) return;
    const nextState = !this.conversation.archived;
    try {
      await firstValueFrom(this.convSvc.archiveConversation(this.conversationId, nextState));
      this.conversation.archived = nextState;
      this.cdr.markForCheck();
      if (nextState) {
        void this.router.navigate([ROUTES.conversations]);
      }
    } catch (e) {
      console.error('Failed to toggle archive state:', e);
      alert('Could not update archive state on server. Please try again.');
    }
  }

  private markReadIfVisible(): void {
    const lastFromOther = [...this.displayMessages]
      .filter(m => !m.isMine && !m.pending)
      .at(-1);
    if (lastFromOther) {
      this.receiptsSvc.markConversationRead(this.conversationId, lastFromOther.id);
    }
  }

  private subscribeToSocket(): void {
    this.subs.add(
      this.socketSvc.receiptUpdate$.subscribe(payload => {
        if (payload.conversationId !== this.conversationId) return;
        this.cdr.detectChanges();
      }),
    );

    // Show messages replayed from the pending queue after a barrier is released.
    this.subs.add(
      this.coordinator.pendingDecryptReplayed$.subscribe(event => {
        if (event.conversationId !== this.conversationId) return;
        for (const msg of event.messages) {
          this.upsertDisplay(msg);
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

        // If already cached (e.g. race condition with gap-fill), skip.
        if (await this.messageCacheSvc.exists(msg.id)) return;

        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;

        const isMine = msg.senderDid === user.did;

        if (isMine && msg.senderDeviceId === device.id) {
          // Same device: sendMessage() owns both cache write and display via the pending entry.
          // knownIds is already updated above — gap-fill won't reprocess this message.
          return;
        }

        const result = await this.coordinator.decryptMessage(
          this.conversationId,
          msg.id,
          msg.senderDid,
          msg.senderDeviceId,
          isMine,
          msg.createdAt,
          msg.ciphertext,
          user,
          device,
        );

        if (result.state === 'pending_decrypt') {
          // Coordinator has queued this message for replay once GroupState is READY.
          // It will appear in the display via pendingDecryptReplayed$.
          return;
        }

        // For own messages from other devices, never mark as undecryptable — store placeholder.
        const undecryptable = !isMine && result.state === 'undecryptable';
        const plaintext     = result.state === 'plaintext' ? result.plaintext : '';

        const cached = this.buildCached(
          msg.id, msg.conversationId, msg.senderDeviceId, msg.senderDid,
          plaintext, isMine, undecryptable, msg.createdAt,
        );
        await this.messageCacheSvc.store(cached);

        if (result.state === 'plaintext') {
          this.syncSvc.enqueue({
            messageId:      msg.id,
            conversationId: msg.conversationId,
            plaintext,
            createdAt:      msg.createdAt,
            senderDid:      msg.senderDid,
          });
        }

        this.upsertDisplay(cached);
        this.markReadIfVisible();
        if (!isMine) {
          this.socketSvc.sendMessageDelivered(msg.conversationId, msg.id, msg.senderDid);
        }
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
          await this.coordinator.processWelcome(
            payload.id,
            payload.welcome,
            this.conversationId,
            user,
            device,
          );
          // Re-restore from backup: A1 flushes pending messages before provisioning,
          // so by the time this device joins the group the backup is up to date.
          // This overwrites any undecryptable cache entries with backup plaintext.
          if (this.syncSvc.isMbkAvailable()) {
            await this.syncSvc.restore();
          }
          // Pending messages were replayed by coordinator.processWelcome() and display
          // was updated via pendingDecryptReplayed$. Load history to fill any server gaps.
          this.mlsGroupReady = true;
          await this.loadHistory();
        } catch (err) {
          if (!environment.production) console.error('[MLS] processWelcome failed:', err);
        }
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

    if (msg.deletedAt !== null)  displayText = '[Deleted]';
    else if (msg.undecryptable)  displayText = '[Encrypted]';
    else if (msg.isMine)         displayText = msg.plaintext || '[Sent]';
    else                         displayText = msg.plaintext;

    return {
      id:          msg.id,
      displayText,
      isMine:      msg.isMine,
      createdAt:   msg.createdAt,
      pending:     false,
    };
  }

  private upsertDisplay(msg: CachedMessage): void {
    const dm  = this.toDisplayMessage(msg);
    const idx = this.displayMessages.findIndex(m => m.id === dm.id);
    if (idx !== -1) {
      this.displayMessages[idx] = dm;
    } else {
      this.displayMessages.push(dm);
    }
  }

  private buildCached(
    id:             string,
    conversationId: string,
    senderDeviceId: string,
    senderDid:      string,
    plaintext:      string,
    isMine:         boolean,
    undecryptable:  boolean,
    createdAt:      number,
  ): CachedMessage {
    return {
      id,
      conversationId,
      senderDeviceId,
      senderDid,
      plaintext,
      isMine,
      undecryptable,
      cacheVersion:      1,
      encryptionVersion: 1,
      deletedAt:         null,
      createdAt,
      cachedAt:          Date.now(),
    };
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

  private scrollToBottom(): void {
    setTimeout(() => {
      void this.ionContent?.scrollToBottom(200);
    }, 50);
  }
}
