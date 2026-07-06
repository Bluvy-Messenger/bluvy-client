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
import { BreakpointService } from '../../../core/layout/breakpoint.service';
import { ContactsService } from '../../../core/contact/contacts.service';
import type { Contact, BlueskyProfile } from '../../../core/contact/contact.types';
import { MlsCoordinatorBase } from '../../../core/mls/coordinator/mls-coordinator.base';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { ROUTES } from '../../../core/routes';
import { environment } from '../../../../environments/environment';

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
  ],
})
export class SidebarListComponent implements OnInit, OnDestroy {
  private convSvc      = inject(ConversationsService);
  private router       = inject(Router);
  private receiptsSvc  = inject(ReceiptsService);
  readonly authSvc     = inject(AuthService);
  private socketSvc    = inject(SocketService);
  private cacheSvc     = inject(MessageCacheService);
  readonly presenceSvc = inject(PresenceService);
  readonly bpSvc       = inject(BreakpointService);
  private contactsSvc  = inject(ContactsService);
  private coordinator  = inject(MlsCoordinatorBase);

  conversations: ConversationListItem[] = [];
  loading = false;
  error   = '';

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
  private unreadSubs           = new Subscription();
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
    }, { allowSignalWrites: true });
  }

  async ngOnInit(): Promise<void> {
    this.setupSocketSubs();
    this.periodicTimer = setInterval(() => void this.load(), SYNC_INTERVAL_MS);
    await this.load();
  }

  ngOnDestroy(): void {
    clearInterval(this.periodicTimer);
    this.unreadSubs.unsubscribe();
    this.subs.unsubscribe();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error   = '';
    try {
      const page = await firstValueFrom(this.convSvc.getConversations(undefined, 50));
      this.conversations = page.data;

      const counts: Record<string, number> = {};
      for (const conv of page.data) counts[conv.id] = conv.unreadCount;
      this.receiptsSvc.setUnreadCounts(counts);
      await this.receiptsSvc.initReadStates();

      this.unreadSubs.unsubscribe();
      this.unreadSubs = new Subscription();
      for (const conv of this.conversations) {
        this.unreadSubs.add(
          this.receiptsSvc.unreadCount$(conv.id).subscribe(count => { conv.unreadCount = count; }),
        );
      }
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
        void this.coordinator.prepareConversation(user, device, contact.did).catch(() => undefined);
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
    const d   = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000) {
      return d.toLocaleDateString([], { weekday: 'short' });
    }
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  private setupSocketSubs(): void {
    this.subs.add(this.socketSvc.messageNew$.subscribe(msg => this.onMessageNew(msg)));
    this.subs.add(this.socketSvc.conversationNew$.subscribe(conv => this.onConversationNew(conv)));
    this.subs.add(this.socketSvc.reconnect$.subscribe(() => void this.load()));
    this.subs.add(
      this.cacheSvc.stored$.subscribe(msg => {
        const conv = this.conversations.find(c => c.lastMessageId === msg.id);
        if (conv) this.previews.set(msg.id, msg.plaintext);
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
        if (cached) this.previews.set(msg.id, cached.plaintext);
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
    this.unreadSubs.add(
      this.receiptsSvc.unreadCount$(payload.id).subscribe(count => {
        const c = this.conversations.find(x => x.id === payload.id);
        if (c) c.unreadCount = count;
      }),
    );
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
        if (cached) this.previews.set(msgId, cached.plaintext);
      }).catch(() => {});
    }
  }
}
