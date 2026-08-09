import { Component, Input, Output, EventEmitter, inject, signal, OnInit } from '@angular/core';
import { IonModal, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { ConversationsService } from '../../../core/conversation/conversations.service';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import type { Contact } from '../../../core/contact/contact.types';
import type { ConversationListItem, ConversationResult } from '../../../core/conversation/conversation.types';

@Component({
  selector: 'app-new-chat-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonModal,
    IonIcon,
    IonSpinner,
    TranslatePipe,
    AvatarComponent,
  ],
  templateUrl: './new-chat-modal.component.html',
  styleUrls: ['./new-chat-modal.component.scss'],
})
export class NewChatModalComponent implements OnInit {
  @Input() isOpen = false;
  @Input() bluvyContacts: Contact[] = [];

  @Output() closed = new EventEmitter<void>();
  @Output() conversationCreated = new EventEmitter<ConversationListItem | ConversationResult>();

  private conversationsSvc = inject(ConversationsService);

  readonly searchQuery = signal('');
  readonly groupName = signal('');
  readonly selectedDids = signal<string[]>([]);
  readonly maxGroupMembers = signal<number>(4);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.conversationsSvc.fetchServerConfig().subscribe({
      next: (config) => {
        if (config && config.maxGroupMembers) {
          this.maxGroupMembers.set(config.maxGroupMembers);
        }
      },
      error: () => {
        // Default to 4 if config fetch fails
      },
    });
  }

  get filteredContacts(): Contact[] {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return this.bluvyContacts;
    return this.bluvyContacts.filter(c =>
      c.handle.toLowerCase().includes(q) ||
      (c.displayName && c.displayName.toLowerCase().includes(q))
    );
  }

  get maxContactsAllowed(): number {
    return Math.max(1, this.maxGroupMembers() - 1);
  }

  get isLimitReached(): boolean {
    return this.selectedDids().length >= this.maxContactsAllowed;
  }

  get isGroupMode(): boolean {
    return this.selectedDids().length > 1;
  }

  toggleContactSelection(did: string): void {
    const current = this.selectedDids();
    if (current.includes(did)) {
      this.selectedDids.set(current.filter(d => d !== did));
    } else {
      if (this.isLimitReached) return;
      this.selectedDids.set([...current, did]);
    }
  }

  isSelected(did: string): boolean {
    return this.selectedDids().includes(did);
  }

  getSelectedContacts(): Contact[] {
    const dids = new Set(this.selectedDids());
    return this.bluvyContacts.filter(c => dids.has(c.did));
  }

  onContactClick(contact: Contact): void {
    // If no multi-selection active yet, clicking directly starts a 1:1 DM
    if (this.selectedDids().length === 0) {
      this.startDm(contact.did);
    } else {
      // If multi-selection is active, toggle checkbox
      this.toggleContactSelection(contact.did);
    }
  }

  submitConversation(): void {
    const dids = this.selectedDids();
    if (dids.length === 0) {
      this.error.set('Veuillez sélectionner au moins un contact');
      return;
    }

    if (dids.length === 1) {
      // Exactly 1 contact selected -> Create/Open 1:1 DM
      this.startDm(dids[0]!);
    } else {
      // > 1 contacts selected -> Create Group conversation
      this.createGroup(dids);
    }
  }

  private startDm(did: string): void {
    this.loading.set(true);
    this.error.set(null);

    this.conversationsSvc.createOrGetDm(did).subscribe({
      next: (res) => {
        this.loading.set(false);
        this.conversationCreated.emit(res);
        this.closeModal();
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.message || err?.message || 'Échec du lancement de la conversation');
      },
    });
  }

  private createGroup(dids: string[]): void {
    if (dids.length > this.maxContactsAllowed) {
      this.error.set(`Nombre maximum de membres dépassé (limite serveur : ${this.maxGroupMembers()})`);
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    const name = this.groupName().trim() || undefined;

    this.conversationsSvc.createGroupConversation(dids, name).subscribe({
      next: (conv) => {
        this.loading.set(false);
        this.conversationCreated.emit(conv);
        this.closeModal();
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.message || err?.message || 'Échec de la création du groupe');
      },
    });
  }

  closeModal(): void {
    this.searchQuery.set('');
    this.groupName.set('');
    this.selectedDids.set([]);
    this.error.set(null);
    this.closed.emit();
  }
}
