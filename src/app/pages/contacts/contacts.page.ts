import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonRefresher, IonRefresherContent, IonIcon,
} from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { PresenceIndicatorComponent } from '../../components/ui/presence-indicator/presence-indicator.component';
import { ContactsService } from '../../core/contact/contacts.service';
import type { BlueskyProfile, Contact } from '../../core/contact/contact.types';
import { ConversationsService } from '../../core/conversation/conversations.service';
import { AuthService } from '../../core/auth/auth.service';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { PresenceService } from '../../core/presence/presence.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';

const INVITE_URL = 'https://bluvy.app';

@Component({
  selector: 'app-contacts',
  templateUrl: './contacts.page.html',
  styleUrls: ['./contacts.page.scss'],
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonRefresher, IonRefresherContent, IonIcon,
    AsyncPipe,
    AvatarComponent, PresenceIndicatorComponent,
    TranslatePipe,
  ],
})
export class ContactsPage implements OnInit {
  private contactsSvc = inject(ContactsService);
  private convSvc     = inject(ConversationsService);
  private authSvc     = inject(AuthService);
  private coordinator = inject(MlsCoordinatorBase);
  private router      = inject(Router);

  readonly presenceSvc = inject(PresenceService);

  bluvyContacts:   Contact[]        = [];
  blueskyContacts: BlueskyProfile[] = [];

  filteredBluvy:    Contact[]        = [];
  filteredBluesky:  BlueskyProfile[] = [];

  loading       = false;
  error         = '';
  searchQuery   = '';
  openingConvId = '';
  invitingDid   = '';

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(forceRefresh = false): Promise<void> {
    const userDid = this.authSvc.currentUser()?.did;
    if (!userDid) return;

    const cached = this.contactsSvc.getCached(userDid);

    // Show any cached data immediately — no spinner, no wait
    if (cached) {
      this.bluvyContacts   = cached.bluvyContacts;
      this.blueskyContacts = cached.blueskyContacts;
      this.applySearch();
    }

    // Only show full-page spinner on true first load (no cached data)
    if (!cached) this.loading = true;
    this.error = '';

    try {
      const result = await this.contactsSvc.sync(userDid, forceRefresh);
      this.bluvyContacts   = result.bluvyContacts;
      this.blueskyContacts = result.blueskyContacts;
      this.applySearch();
    } catch {
      // If we showed stale data, keep it and stay silent on error
      if (!cached) this.error = 'Could not load contacts. Pull down to refresh.';
    } finally {
      this.loading = false;
    }
  }

  onSearch(event: Event): void {
    this.searchQuery = (event.target as HTMLInputElement).value ?? '';
    this.applySearch();
  }

  async handleRefresh(event: CustomEvent): Promise<void> {
    await this.load(true);
    (event.target as HTMLIonRefresherElement).complete();
  }

  async openConversation(contact: Contact): Promise<void> {
    this.openingConvId = contact.did;
    this.error         = '';
    try {
      const conv = await firstValueFrom(this.convSvc.createOrGetDm(contact.did));

      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (user && device) {
        void this.coordinator.prepareConversation(user, device, contact.did).catch(() => undefined);
      }

      await this.router.navigate(['/tabs/conversations', conv.id]);
    } catch {
      this.error = 'Could not start conversation. Please try again.';
    } finally {
      this.openingConvId = '';
    }
  }

  async invite(profile: BlueskyProfile): Promise<void> {
    this.invitingDid = profile.did;
    const text = `Hey! I use Bluvy for end-to-end encrypted messaging. Join me: ${INVITE_URL}`;

    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Join me on Bluvy', text, url: INVITE_URL });
      } else {
        await navigator.clipboard.writeText(`${text}`);
      }
    } catch {
      // User cancelled share or clipboard unavailable — no action needed.
    } finally {
      this.invitingDid = '';
    }
  }

  get hasAnyContacts(): boolean {
    return this.bluvyContacts.length > 0 || this.blueskyContacts.length > 0;
  }

  get hasAnyFiltered(): boolean {
    return this.filteredBluvy.length > 0 || this.filteredBluesky.length > 0;
  }

  private applySearch(): void {
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) {
      this.filteredBluvy   = [...this.bluvyContacts];
      this.filteredBluesky = [...this.blueskyContacts];
      return;
    }
    const match = (handle: string, displayName: string | null) =>
      handle.toLowerCase().includes(q) || (displayName?.toLowerCase().includes(q) ?? false);

    this.filteredBluvy   = this.bluvyContacts.filter(c   => match(c.handle, c.displayName));
    this.filteredBluesky = this.blueskyContacts.filter(c => match(c.handle, c.displayName));
  }
}
