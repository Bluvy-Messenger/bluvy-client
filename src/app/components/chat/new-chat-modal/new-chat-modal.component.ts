import { Component, input, output, ViewChild, inject, signal, computed, OnInit } from '@angular/core';
import { IonModal, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ConversationsService } from '../../../core/conversation/conversations.service';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import type { Contact } from '../../../core/contact/contact.types';
import type { ConversationListItem, ConversationResult } from '../../../core/conversation/conversation.types';

@Component({
  selector: 'app-new-chat-modal',
  imports: [
    CommonModule,
    FormsModule,
    IonModal,
    IonIcon,
    IonSpinner,
    AvatarComponent,
  ],
  templateUrl: './new-chat-modal.component.html',
  styleUrls: ['./new-chat-modal.component.scss'],
})
export class NewChatModalComponent implements OnInit {
  readonly isOpen = input<boolean>(false);
  readonly bluvyContacts = input<Contact[]>([]);

  @ViewChild(IonModal) private modal?: IonModal;

  readonly closed = output<void>();
  readonly conversationCreated = output<ConversationListItem | ConversationResult>();

  private conversationsSvc = inject(ConversationsService);

  readonly searchQuery = signal('');
  readonly groupName = signal('');
  readonly selectedDids = signal<string[]>([]);
  readonly maxGroupMembers = signal<number>(4);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly filteredContacts = computed<Contact[]>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const list = this.bluvyContacts();
    if (!q) return list;
    return list.filter(c =>
      c.handle.toLowerCase().includes(q) ||
      (c.displayName && c.displayName.toLowerCase().includes(q))
    );
  });

  readonly maxContactsAllowed = computed<number>(() => Math.max(1, this.maxGroupMembers() - 1));
  readonly isLimitReached = computed<boolean>(() => this.selectedDids().length >= this.maxContactsAllowed());
  readonly isGroupMode = computed<boolean>(() => this.selectedDids().length > 1);

  ngOnInit(): void {
    this.conversationsSvc.fetchServerConfig().subscribe({
      next: (config) => {
        if (config && config.maxGroupMembers) {
          this.maxGroupMembers.set(config.maxGroupMembers);
        }
      },
      error: () => {},
    });
  }

  toggleContactSelection(did: string): void {
    const current = this.selectedDids();
    if (current.includes(did)) {
      this.selectedDids.set(current.filter(d => d !== did));
    } else {
      if (this.isLimitReached()) return;
      this.selectedDids.set([...current, did]);
    }
  }

  isSelected(did: string): boolean {
    return this.selectedDids().includes(did);
  }

  getSelectedContacts(): Contact[] {
    const dids = new Set(this.selectedDids());
    return this.bluvyContacts().filter(c => dids.has(c.did));
  }

  onContactClick(contact: Contact): void {
    if (this.selectedDids().length === 0) {
      this.startDm(contact.did);
    } else {
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
      this.startDm(dids[0]!);
    } else {
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
    if (dids.length > this.maxContactsAllowed()) {
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
    void this.modal?.dismiss();
    this.closed.emit();
  }
}
