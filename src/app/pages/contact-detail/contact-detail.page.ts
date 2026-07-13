import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { IonContent, IonIcon, IonModal, ToastController } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { ContactsService } from '../../core/contact/contacts.service';
import type { Contact, BlueskyProfile } from '../../core/contact/contact.types';
import { ConversationsService } from '../../core/conversation/conversations.service';
import { AuthService } from '../../core/auth/auth.service';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { MessageCacheService } from '../../core/conversation/message-cache.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';
import { environment } from '../../../environments/environment';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Browser } from '@capacitor/browser';
import { addIcons } from 'ionicons';
import {
  close, chatbubbleEllipsesOutline, linkOutline, shareSocialOutline,
  volumeMuteOutline, volumeHighOutline, trashOutline, banOutline, documentTextOutline,
  paperPlaneOutline, chatbubbleOutline, shieldCheckmarkOutline, fingerPrintOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-contact-detail',
  templateUrl: './contact-detail.page.html',
  styleUrls: ['./contact-detail.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, IonModal, AvatarComponent, TranslatePipe, AsyncPipe],
})
export class ContactDetailPage {
  private route           = inject(ActivatedRoute);
  private router          = inject(Router);
  private contactsSvc     = inject(ContactsService);
  private convSvc         = inject(ConversationsService);
  private authSvc         = inject(AuthService);
  private coordinator     = inject(MlsCoordinatorBase);
  private messageCacheSvc = inject(MessageCacheService);
  private toastCtrl       = inject(ToastController);
  private i18n            = inject(TranslationService);

  protected readonly environment = environment;

  did: string = '';
  contact: Contact | null = null;
  blueskyProfile: BlueskyProfile | null = null;
  loading = false;
  openingConv = false;
  inviting = false;
  error = '';

  bio = '';
  conversationId: string | null = null;
  sharedLinks: string[] = [];

  isInviteModalOpen = false;
  directInviteUrl = '';
  personalInviteUrl = '';
  qrCodeUrl = '';

  constructor() {
    addIcons({
      close, chatbubbleEllipsesOutline, linkOutline, shareSocialOutline,
      volumeMuteOutline, volumeHighOutline, trashOutline, banOutline, documentTextOutline,
      paperPlaneOutline, chatbubbleOutline, shieldCheckmarkOutline, fingerPrintOutline
    });
  }

  async ionViewWillEnter(): Promise<void> {
    const routeParams = this.route.snapshot.paramMap;
    this.did = routeParams.get('did') || '';
    if (this.did) {
      await this.loadContact();
    }
  }

  async loadContact(): Promise<void> {
    const userDid = this.authSvc.currentUser()?.did;
    if (!userDid) return;

    this.loading = true;
    this.error = '';

    try {
      const result = await this.contactsSvc.sync(userDid);
      this.contact = result.bluvyContacts.find(c => c.did === this.did) || null;
      if (!this.contact) {
        this.blueskyProfile = result.blueskyContacts.find(c => c.did === this.did) || null;
      }
      await this.loadAdditionalData();
    } catch {
      this.error = this.i18n.t('contact_detail.error_load');
    } finally {
      this.loading = false;
    }
  }

  goBack(): void {
    void this.router.navigate([ROUTES.contacts]);
  }

  async openMessage(): Promise<void> {
    if (!this.contact) return;
    this.openingConv = true;
    this.error = '';
    try {
      const conv = await firstValueFrom(this.convSvc.createOrGetDm(this.contact.did));
      const user = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (user && device) {
        void this.coordinator.prepareConversation(user, device, this.contact.did).catch(() => undefined);
      }
      void this.router.navigate([ROUTES.conversation(conv.id)]);
    } catch {
      this.error = this.i18n.t('contact_detail.error_start_conversation');
    } finally {
      this.openingConv = false;
    }
  }

  async invite(): Promise<void> {
    if (!this.blueskyProfile) return;
    
    const userDid = this.authSvc.currentUser()?.did || '';
    const cleanOrigin = window.location.origin.endsWith('/') ? window.location.origin.slice(0, -1) : window.location.origin;
    
    // Direct invite containing only the inviter's DID (so others can start a conversation)
    this.directInviteUrl = environment.production
      ? `https://bluvy.app/message#${userDid}`
      : `${cleanOrigin}/message#${userDid}`;

    // Personal invite linking both user DIDs together
    this.personalInviteUrl = environment.production
      ? `https://bluvy.app/message#${userDid}+${this.did}`
      : `${cleanOrigin}/message#${userDid}+${this.did}`;

    this.qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(this.directInviteUrl)}`;
    
    this.isInviteModalOpen = true;
  }

  async shareViaBlueskyDm(): Promise<void> {
    const text = this.i18n.t('contact_detail.invite_message', { url: this.personalInviteUrl });

    try {
      await navigator.clipboard.writeText(text);
      const toast = await this.toastCtrl.create({
        message: this.i18n.t('contact_detail.invite_copied'),
        duration: 3000,
        position: 'bottom',
        color: 'success'
      });
      await toast.present();
    } catch {
      // Ignored
    }

    const bskyUrl = 'https://bsky.app/messages';
    if (Capacitor.isNativePlatform()) {
      await Browser.open({ url: bskyUrl, presentationStyle: 'popover' });
    } else {
      window.open(bskyUrl, '_blank', 'noopener,noreferrer');
    }
    this.isInviteModalOpen = false;
  }

  async copyDirectLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.directInviteUrl);
      const toast = await this.toastCtrl.create({
        message: this.i18n.t('contact_detail.link_copied'),
        duration: 3000,
        position: 'bottom',
        color: 'success'
      });
      await toast.present();
    } catch {
      // Ignored
    }
    this.isInviteModalOpen = false;
  }

  async shareQrCode(): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) {
        await Share.share({
          title: this.i18n.t('contact_detail.qr_title'),
          text: this.i18n.t('contact_detail.qr_text'),
          url: this.directInviteUrl,
          dialogTitle: this.i18n.t('contact_detail.qr_share_dialog')
        });
      } else if (typeof navigator.share === 'function') {
        await navigator.share({
          title: this.i18n.t('contact_detail.qr_title'),
          text: this.i18n.t('contact_detail.qr_text'),
          url: this.directInviteUrl
        });
      } else {
        window.open(this.qrCodeUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // Ignored
    }
  }

  async loadAdditionalData(): Promise<void> {
    this.bio = '';
    this.sharedLinks = [];
    this.conversationId = null;

    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(this.did)}`);
      if (res.ok) {
        const data = await res.json();
        this.bio = data.description || '';
      }
    } catch (e) {
      console.warn('Failed to fetch profile description:', e);
    }

    if (!this.contact) {
      return;
    }

    try {
      const page = await firstValueFrom(this.convSvc.getConversations(undefined, 100));
      const existing = page.data.find(c => c.participant.did === this.did);
      if (existing) {
        this.conversationId = existing.id;
        const user = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (user && device) {
          await this.messageCacheSvc.initialize(user.did, device.id);
          const cacheResult = await this.messageCacheSvc.getMessages(this.conversationId, 500, true);
          const linkRegex = /https?:\/\/[^\s$.?#].[^\s]*/gi;
          const links: string[] = [];
          for (const msg of cacheResult.messages) {
            const matches = msg.plaintext.match(linkRegex);
            if (matches) {
              links.push(...matches);
            }
          }
          this.sharedLinks = [...new Set(links)];
        }
      }
    } catch (e) {
      console.warn('Failed to load conversation details on profile:', e);
    }
  }

  getSafetyNumber(): string {
    if (!this.did) return '';
    const userDid = this.authSvc.currentUser()?.did || '';
    const str = [userDid, this.did].sort().join(':');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    const abs = Math.abs(hash).toString().padStart(10, '0');
    const block1 = abs.slice(0, 5);
    const block2 = abs.slice(5, 10);
    const block3 = String(Math.abs(hash * 3) % 100000).padStart(5, '0');
    const block4 = String(Math.abs(hash * 7) % 100000).padStart(5, '0');
    return `${block1} ${block2} ${block3} ${block4}`;
  }

  getMlsActive(): boolean {
    if (!this.conversationId) return false;
    return this.coordinator.isConversationReady(this.conversationId);
  }

  isMuted(): boolean {
    if (!this.conversationId) return false;
    return localStorage.getItem('muted_conv_' + this.conversationId) === 'true';
  }

  toggleMute(): void {
    if (!this.conversationId) return;
    if (this.isMuted()) {
      localStorage.removeItem('muted_conv_' + this.conversationId);
    } else {
      localStorage.setItem('muted_conv_' + this.conversationId, 'true');
    }
  }

  async clearLocalHistoryPrompt(): Promise<void> {
    if (!this.conversationId) return;
    const confirmClear = confirm(this.i18n.t('contact_detail.confirm_clear_history') || this.i18n.t('conversation.confirm_clear_history'));
    if (!confirmClear) return;

    const user = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    await this.messageCacheSvc.clearConversation(this.conversationId);
    this.sharedLinks = [];
    const toast = await this.toastCtrl.create({
      message: 'Historique local effacé avec succès.',
      duration: 3000,
      color: 'success',
      position: 'bottom'
    });
    await toast.present();
  }

  isBlocked(): boolean {
    return localStorage.getItem('blocked_contact_' + this.did) === 'true';
  }

  async blockContact(): Promise<void> {
    if (this.isBlocked()) {
      localStorage.removeItem('blocked_contact_' + this.did);
      const toast = await this.toastCtrl.create({
        message: 'Contact débloqué avec succès.',
        duration: 3000,
        color: 'success',
        position: 'bottom'
      });
      await toast.present();
    } else {
      localStorage.setItem('blocked_contact_' + this.did, 'true');
      const toast = await this.toastCtrl.create({
        message: 'Contact bloqué avec succès.',
        duration: 3000,
        color: 'success',
        position: 'bottom'
      });
      await toast.present();
    }
  }
}
