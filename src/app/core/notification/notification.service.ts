import { Injectable, inject, signal, NgZone } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { filter, firstValueFrom } from 'rxjs';
import { SocketService, MessageNewPayload } from '../infrastructure/socket.service';
import { AuthService } from '../auth/auth.service';
import { ConversationsService } from '../conversation/conversations.service';
import { ContactsService } from '../contact/contacts.service';
import { MessageCacheService, CachedMessage } from '../conversation/message-cache.service';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { TranslationService } from '../i18n/translation.service';
import { ROUTES } from '../routes';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly socketSvc       = inject(SocketService);
  private readonly authSvc         = inject(AuthService);
  private readonly conversationsSvc = inject(ConversationsService);
  private readonly contactsSvc      = inject(ContactsService);
  private readonly cacheSvc         = inject(MessageCacheService);
  private readonly coordinator      = inject(MlsCoordinatorBase);
  private readonly router           = inject(Router);
  private readonly toastCtrl         = inject(ToastController);
  private readonly translationSvc   = inject(TranslationService);
  private readonly zone             = inject(NgZone);

  private readonly activeConversationId = signal<string | null>(null);

  readonly isToastOpen    = signal<boolean>(false);
  readonly isToastClosing = signal<boolean>(false);
  readonly toastTitle     = signal<string>('');
  readonly toastText      = signal<string>('');
  readonly toastAvatar    = signal<string>('assets/default-avatar.png');
  readonly toastConvId    = signal<string>('');

  private toastTimer:   ReturnType<typeof setTimeout> | null = null;
  private closingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TOAST_DURATION_MS  = 4500;
  private readonly CLOSE_ANIMATION_MS = 380;

  initialize(): void {
    // 1. Track active conversation from route
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe(() => {
      const match = this.router.url.match(/\/conversations\/([a-zA-Z0-9-]+)/);
      this.activeConversationId.set(match ? match[1]! : null);
    });

    // 2. Listen to incoming messages
    this.socketSvc.messageNew$.subscribe(async (msg) => {
      await this.handleIncomingMessage(msg);
    });
  }

  private async handleIncomingMessage(msg: MessageNewPayload): Promise<void> {
    const user = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    // Do not notify for our own messages
    if (msg.senderDid === user.did) return;

    // Decrypt the message in the background first so that:
    // a) It's added to the cache (this automatically updates UI previews in sidebar-list)
    // b) We can display the decrypted content in the notification toast
    let decryptedText = this.translationSvc.t('notifications.new_message');
    try {
      const result = await this.coordinator.decryptMessage(
        msg.conversationId,
        msg.id,
        msg.senderDid,
        msg.senderDeviceId,
        false, // isMine
        msg.createdAt,
        msg.ciphertext,
        user,
        device
      );

      if (result.state === 'plaintext') {
        decryptedText = result.plaintext;
        // Store in cache if not already stored
        if (this.cacheSvc.isInitialized()) {
          const cached: CachedMessage = {
            id: msg.id,
            conversationId: msg.conversationId,
            senderDeviceId: msg.senderDeviceId,
            senderDid: msg.senderDid,
            plaintext: result.plaintext,
            isMine: false,
            undecryptable: false,
            cacheVersion: 1,
            encryptionVersion: 1,
            deletedAt: null,
            createdAt: msg.createdAt,
            cachedAt: Date.now(),
          };
          await this.cacheSvc.store(cached);
        }
      }
    } catch (err) {
      // If decryption fails, we still proceed with displaying a generic notification
    }

    // Only display in-app toast if the user is NOT actively looking at this conversation AND in-app notifications are enabled
    if (this.activeConversationId() !== msg.conversationId && this.isInAppEnabled()) {
      await this.showInAppToast(msg, decryptedText);
    }
  }

  private async showInAppToast(msg: MessageNewPayload, text: string): Promise<void> {
    // Resolve sender profile details
    let displayName = msg.senderDid.substring(0, 12);
    let avatarUrl = 'assets/default-avatar.png';

    const currentUser = this.authSvc.currentUser();
    if (currentUser) {
      const contacts = this.contactsSvc.getCached(currentUser.did);
      if (contacts) {
        const contact = contacts.bluvyContacts.find(c => c.did === msg.senderDid);
        if (contact) {
          displayName = contact.displayName || contact.handle;
          avatarUrl = contact.avatarUrl || avatarUrl;
        }
      }
    }

    // If still not resolved from contact cache, query the conversation object
    if (displayName === msg.senderDid.substring(0, 12)) {
      try {
        const conv = await firstValueFrom(this.conversationsSvc.getConversationById(msg.conversationId));
        if (conv && conv.participant && conv.participant.did === msg.senderDid) {
          displayName = conv.participant.displayName || conv.participant.handle;
          avatarUrl = conv.participant.avatarUrl || avatarUrl;
        }
      } catch {
        // ignore
      }
    }

    // Set state signals inside Angular zone to trigger change detection
    this.zone.run(() => {
      this.toastTitle.set(displayName);
      this.toastText.set(text);
      this.toastAvatar.set(avatarUrl);
      this.toastConvId.set(msg.conversationId);
      this.isToastOpen.set(true);
    });

    // Auto-dismiss after TOAST_DURATION_MS — reset timer if a new message arrives
    this.scheduleAutoDismiss();
  }

  private scheduleAutoDismiss(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.closeToast();
      this.toastTimer = null;
    }, this.TOAST_DURATION_MS);
  }

  /** Called by AuthService on every account switch to reset notification state. */
  onAccountSwitch(): void {
    this.clearAllTimers();
    this.zone.run(() => {
      this.isToastClosing.set(false);
      this.isToastOpen.set(false);
      this.toastTitle.set('');
      this.toastText.set('');
      this.toastAvatar.set('assets/default-avatar.png');
      this.toastConvId.set('');
    });
  }

  closeToast(): void {
    this.clearAllTimers();
    // Trigger the exit animation first, then remove from DOM after it completes
    this.zone.run(() => this.isToastClosing.set(true));
    this.closingTimer = setTimeout(() => {
      this.zone.run(() => {
        this.isToastOpen.set(false);
        this.isToastClosing.set(false);
      });
      this.closingTimer = null;
    }, this.CLOSE_ANIMATION_MS);
  }

  private clearAllTimers(): void {
    if (this.toastTimer)   { clearTimeout(this.toastTimer);   this.toastTimer   = null; }
    if (this.closingTimer) { clearTimeout(this.closingTimer); this.closingTimer = null; }
  }

  setFallbackAvatar(): void {
    this.zone.run(() => {
      this.toastAvatar.set('assets/default-avatar.png');
    });
  }

  openToastConversation(): void {
    const convId = this.toastConvId();
    if (convId) {
      this.zone.run(() => {
        void this.router.navigate([ROUTES.conversation(convId)]);
      });
    }
    this.closeToast();
  }

  setInAppEnabled(enabled: boolean): void {
    localStorage.setItem('notifications_in_app_enabled', String(enabled));
  }

  isInAppEnabled(): boolean {
    return localStorage.getItem('notifications_in_app_enabled') !== 'false';
  }
}
