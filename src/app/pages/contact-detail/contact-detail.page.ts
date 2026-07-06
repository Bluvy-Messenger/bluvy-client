import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { ContactsService } from '../../core/contact/contacts.service';
import type { Contact, BlueskyProfile } from '../../core/contact/contact.types';
import { ConversationsService } from '../../core/conversation/conversations.service';
import { AuthService } from '../../core/auth/auth.service';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-contact-detail',
  templateUrl: './contact-detail.page.html',
  styleUrls: ['./contact-detail.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, AvatarComponent, TranslatePipe, AsyncPipe],
})
export class ContactDetailPage {
  private route       = inject(ActivatedRoute);
  private router      = inject(Router);
  private contactsSvc = inject(ContactsService);
  private convSvc     = inject(ConversationsService);
  private authSvc     = inject(AuthService);
  private coordinator = inject(MlsCoordinatorBase);

  did: string = '';
  contact: Contact | null = null;
  blueskyProfile: BlueskyProfile | null = null;
  loading = false;
  openingConv = false;
  inviting = false;
  error = '';

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
    } catch {
      this.error = 'Could not load contact details.';
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
      this.error = 'Could not start conversation. Please try again.';
    } finally {
      this.openingConv = false;
    }
  }

  async invite(): Promise<void> {
    if (!this.blueskyProfile) return;
    this.inviting = true;

    const userDid = this.authSvc.currentUser()?.did || '';
    const cleanOrigin = window.location.origin.endsWith('/') ? window.location.origin.slice(0, -1) : window.location.origin;
    const inviteUrl = environment.production
      ? `https://bluvy.app/message#${userDid}+${this.did}`
      : `${cleanOrigin}/message#${userDid}+${this.did}`;

    const text = `Hey! I use Bluvy for end-to-end encrypted messaging. Join me: ${inviteUrl}`;

    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Join me on Bluvy', text, url: inviteUrl });
      } else {
        await navigator.clipboard.writeText(`${text}`);
      }
    } catch {
      // Ignored
    } finally {
      this.inviting = false;
    }
  }
}
