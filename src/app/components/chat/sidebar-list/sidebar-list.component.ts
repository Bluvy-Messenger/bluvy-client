import { Component, OnDestroy, OnInit, inject, signal, computed, effect } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { Subscription, firstValueFrom } from 'rxjs';
import { filter, map, startWith } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonText, IonIcon } from '@ionic/angular/standalone';
import { ConversationItemComponent } from '../conversation-item/conversation-item.component';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { ConversationsService } from '../../../core/conversation/conversations.service';
import { AuthService } from '../../../core/auth/auth.service';
import type { ConversationListItem } from '../../../core/conversation/conversation.types';
import { PresenceService } from '../../../core/presence/presence.service';
import { ReceiptsService } from '../../../core/receipts/receipts.service';
import { SocketService } from '../../../core/infrastructure/socket.service';
import type { MessageNewPayload, ConversationNewPayload } from '../../../core/infrastructure/socket.service';
import { MessageCacheService } from '../../../core/conversation/message-cache.service';
import { MessagePayloadHelper } from '../../../core/conversation/message-payload.helper';
import { BreakpointService } from '../../../core/layout/breakpoint.service';
import { ContactsService } from '../../../core/contact/contacts.service';
import type { Contact, BlueskyProfile } from '../../../core/contact/contact.types';
import { MlsCoordinatorBase } from '../../../core/mls/coordinator/mls-coordinator.base';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { ROUTES } from '../../../core/routes';
import { environment } from '../../../../environments/environment';

import { NewChatModalComponent } from '../new-chat-modal/new-chat-modal.component';

const SYNC_INTERVAL_MS = 3 * 60 * 1000;

@Component({
  selector: 'app-sidebar-list',
  templateUrl: './sidebar-list.component.html',
  styleUrls: ['./sidebar-list.component.scss'],
  standalone: true,
  imports: [
    IonText,
    IonIcon,
    AsyncPipe,
    ConversationItemComponent,
    AvatarComponent,
    TranslatePipe,
    NewChatModalComponent,
  ],
})
export class SidebarListComponent implements OnInit, OnDestroy {
  private convSvc      = inject(ConversationsService);
  private router       = inject(Router);
  readonly receiptsSvc = inject(ReceiptsService);
  readonly authSvc     = inject(AuthService);
  private socketSvc    = inject(SocketService);
  private cacheSvc     = inject(MessageCacheService);
  readonly presenceSvc = inject(PresenceService);
  readonly bpSvc       = inject(BreakpointService);
  private contactsSvc  = inject(ContactsService);
  private coordinator  = inject(MlsCoordinatorBase);
  private i18n         = inject(TranslationService);

  conversations: ConversationListItem[] = [];
  loading = false;
  error   = '';
  viewingArchived = false;
  isNewChatModalOpen = false;

  activeTab: 'conversations' | 'contacts' = 'conversations';

  contactsLoading  = false;
  contactSearchQuery = '';
  openingContactId = '';
  bluvyContacts:   Contact[]        = [];
  blueskyContacts: BlueskyProfile[] = [];
  filteredBluvy:   Contact[]        = [];
  filteredBluesky: BlueskyProfile[] = [];

  private readonly previews    = new Map<string, string>();
  private readonly subs        = new Subscription();
  private periodicTimer?: ReturnType<typeof setInterval>;

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd),
      map(e => (e as NavigationEnd).urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  readonly selectedConvId = computed(() => {
    const url = this.currentUrl();
    if (!url) return null;
    const match = url.match(/\/conversations\/([^\/\?]+)/);
    return match ? match[1] : null;
  });

  readonly selectedContactDid = computed(() => {
    const url = this.currentUrl();
    if (!url) return null;
    const match = url.match(/\/contacts\/([^\/\?]+)/);
    return match ? match[1] : null;
  });

  constructor() {
    // Reactively update the active sub-tab based on the URL context
    effect(() => {
      const url = this.currentUrl();
      if (url?.startsWith('/contacts')) {
        this.activeTab = 'contacts';
        if (!this.contactsLoading && this.bluvyContacts.length === 0 && this.blueskyContacts.length === 0) {
          void this.loadContacts();
        }
      } else if (url?.startsWith('/conversations')) {
        this.activeTab = 'conversations';
      }
    });

    // Reactively reload conversations and contacts when the active user changes
    effect(() => {
      const user = this.authSvc.currentUser();
      if (user) {
        this.conversations = [];
        this.bluvyContacts = [];
        this.blueskyContacts = [];
        this.previews.clear();

        setTimeout(() => {
          void this.load();
          void this.loadContacts();
        });
      }
    });
  }

  async ngOnInit(): Promise<void> {
    this.setupSocketSubs();
    this.subs.add(
      this.convSvc.conversationDeleted$.subscribe(deletedId => {
        this.conversations = this.conversations.filter(c => c.id !== deletedId);
      })
    );
    this.subs.add(
      this.convSvc.conversationArchived$.subscribe(event => {
        if (event.archived) {
          this.conversations = this.conversations.filter(c => c.id !== event.id);
        } else {
          void this.load();
        }
      })
    );
    this.periodicTimer = setInterval(() => void this.load(), SYNC_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    clearInterval(this.periodicTimer);
    this.subs.unsubscribe();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error   = '';
    try {
      const page = await firstValueFrom(this.convSvc.getConversations(undefined, 50, this.viewingArchived));
      this.conversations = page.data;

      const counts: Record<string, number> = {};
      for (const conv of page.data) counts[conv.id] = conv.unreadCount;
      this.receiptsSvc.setUnreadCounts(counts);
      await this.receiptsSvc.initReadStates();

      this.loadPreviews();
    } catch {
      this.error = 'Could not load conversations.';
    } finally {
      this.loading = false;
    }
  }

  openConversation(conv: ConversationListItem): void {
    void this.router.navigate([ROUTES.conversation(conv.id)]);
  }

  switchTab(tab: 'conversations' | 'contacts'): void {
    this.activeTab = tab;
    if (tab === 'conversations') {
      void this.router.navigate([ROUTES.conversations]);
    } else {
      void this.router.navigate([ROUTES.contacts]);
    }
  }

  openMenu(): void {
    void this.router.navigate([ROUTES.menu]);
  }

  openArchives(): void {
    this.viewingArchived = true;
    void this.load();
  }

  openNewChatModal(): void {
    if (this.bluvyContacts.length === 0) {
      void this.loadContacts();
    }
    this.isNewChatModalOpen = true;
  }

  closeNewChatModal(): void {
    this.isNewChatModalOpen = false;
  }

  onNewConversationCreated(conv: ConversationListItem | { id: string }): void {
    this.isNewChatModalOpen = false;
    void this.load();
    void this.router.navigate([ROUTES.conversation(conv.id)]);
  }

  closeArchives(): void {
    this.viewingArchived = false;
    void this.load();
  }

  async loadContacts(): Promise<void> {
    const userDid = this.authSvc.currentUser()?.did;
    if (!userDid) return;
    this.contactsLoading = true;
    try {
      const result = await this.contactsSvc.sync(userDid);
      this.bluvyContacts   = result.bluvyContacts;
      this.blueskyContacts = result.blueskyContacts;
      this.applyContactSearch();
    } finally {
      this.contactsLoading = false;
    }
  }

  onContactSearch(event: Event): void {
    this.contactSearchQuery = (event.target as HTMLInputElement).value ?? '';
    this.applyContactSearch();
  }

  async openContactConversation(contact: Contact): Promise<void> {
    this.openingContactId = contact.did;
    try {
      const conv = await firstValueFrom(this.convSvc.createOrGetDm(contact.did));
      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (user && device) {
        void this.coordinator.prepareConversation(user, device, contact.did)
          .catch(err => console.warn('[SidebarList] prepareConversation (pre-warm) failed:', err));
      }
      void this.router.navigate([ROUTES.conversation(conv.id)]);
    } catch (err) {
      if (!environment.production) console.error('[SidebarListComponent] openContact failed:', err);
    } finally {
      this.openingContactId = '';
    }
  }

  openContactProfile(profile: BlueskyProfile): void {
    void this.router.navigate([ROUTES.contact(profile.did)]);
  }

  private applyContactSearch(): void {
    const q = this.contactSearchQuery.toLowerCase().trim();
    if (!q) {
      this.filteredBluvy   = [...this.bluvyContacts];
      this.filteredBluesky = [...this.blueskyContacts];
      return;
    }
    const m = (h: string, n: string | null) => h.toLowerCase().includes(q) || (n?.toLowerCase().includes(q) ?? false);
    this.filteredBluvy   = this.bluvyContacts.filter(c   => m(c.handle, c.displayName));
    this.filteredBluesky = this.blueskyContacts.filter(c => m(c.handle, c.displayName));
  }

  getPreview(conv: ConversationListItem): string {
    if (!conv.lastMessageAt) return '';
    if (conv.lastMessageId) {
      const cached = this.previews.get(conv.lastMessageId);
      if (cached !== undefined) return cached;
    }
    return 'Nouveau message';
  }

  formatTime(ts: number | null): string {
    if (!ts) return '';
    const d      = new Date(ts);
    const now    = new Date();
    const locale = this.i18n.locale === 'fr' ? 'fr-FR' : 'en-US';
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }
    if (now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000) {
      return d.toLocaleDateString(locale, { weekday: 'short' });
    }
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  }

  private setupSocketSubs(): void {
    this.subs.add(this.socketSvc.messageNew$.subscribe(msg => this.onMessageNew(msg)));
    this.subs.add(this.socketSvc.conversationNew$.subscribe(conv => this.onConversationNew(conv)));
    this.subs.add(
      this.socketSvc.conversationUpdated$.subscribe(updated => {
        const idx = this.conversations.findIndex(c => c.id === updated.id);
        if (idx !== -1) {
          this.conversations[idx] = { ...this.conversations[idx]!, name: updated.name ?? this.conversations[idx]!.name };
        } else {
          void this.load();
        }
      }),
    );
    this.subs.add(this.socketSvc.reconnect$.subscribe(() => void this.load()));
    // Root Cause #3 fallback (see AUDIT_02/04/05): a conversation was just
    // recreated. conversation:new (handled above) adds the successor, but
    // nothing was ever removing the superseded original from this list --
    // it stayed until the next full load() (or forever, for its unread
    // count -- see ReceiptsService.removeConversation), showing as a
    // duplicate entry and inflating the unread badge.
    this.subs.add(
      this.socketSvc.conversationSuperseded$.subscribe(({ oldConversationId }) => {
        this.conversations = this.conversations.filter(c => c.id !== oldConversationId);
        this.receiptsSvc.removeConversation(oldConversationId);
      }),
    );
    this.subs.add(
      this.cacheSvc.stored$.subscribe(msg => {
        const conv = this.conversations.find(c => c.lastMessageId === msg.id);
        if (conv) this.previews.set(msg.id, this.formatPreview(msg.plaintext));
      }),
    );
  }

  private onMessageNew(msg: MessageNewPayload): void {
    const idx = this.conversations.findIndex(c => c.id === msg.conversationId);
    if (idx === -1) { void this.load(); return; }
    const conv = this.conversations[idx]!;
    conv.lastMessageAt        = msg.createdAt;
    conv.lastMessageId        = msg.id;
    conv.lastMessageSenderDid = msg.senderDid;
    this.sortConversations();
    if (this.cacheSvc.isInitialized()) {
      void this.cacheSvc.getById(msg.id).then(cached => {
        if (cached) this.previews.set(msg.id, this.formatPreview(cached.plaintext));
      }).catch(() => {});
    }
  }

  private onConversationNew(payload: ConversationNewPayload): void {
    if (this.conversations.some(c => c.id === payload.id)) return;
    const newConv: ConversationListItem = {
      id: payload.id, type: payload.type, createdAt: payload.createdAt,
      lastMessageAt: payload.lastMessageAt, lastMessageId: payload.lastMessageId,
      lastMessageSenderDid: payload.lastMessageSenderDid, unreadCount: payload.unreadCount,
      participant: payload.participant,
    };
    this.conversations = [newConv, ...this.conversations];
    this.sortConversations();
  }

  private sortConversations(): void {
    this.conversations = [...this.conversations].sort((a, b) => {
      const aTime = a.lastMessageAt ?? a.createdAt;
      const bTime = b.lastMessageAt ?? b.createdAt;
      return bTime - aTime;
    });
  }

  private loadPreviews(): void {
    if (!this.cacheSvc.isInitialized()) return;
    for (const conv of this.conversations) {
      if (!conv.lastMessageId) continue;
      const msgId = conv.lastMessageId;
      void this.cacheSvc.getById(msgId).then(cached => {
        if (cached) this.previews.set(msgId, this.formatPreview(cached.plaintext));
      }).catch(() => {});
    }
  }

  private formatPreview(plaintext: string): string {
    const parsed = MessagePayloadHelper.parseMessagePayload(plaintext);
    if (parsed.type === 'chat') {
      return parsed.text;
    }
    if (parsed.type === 'reaction') {
      return `A réagi ${parsed.reaction.emoji}`;
    }
    return plaintext;
  }
}
