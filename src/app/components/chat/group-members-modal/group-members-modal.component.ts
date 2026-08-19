import { Component, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonModal, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, createOutline, checkmarkOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import type { ConversationParticipant } from '../../../core/conversation/conversation.types';

@Component({
  selector: 'app-group-members-modal',
  imports: [
    FormsModule,
    IonModal, IonIcon,
    TranslatePipe,
    AvatarComponent,
  ],
  templateUrl: './group-members-modal.component.html',
  styleUrls: ['./group-members-modal.component.scss'],
})
export class GroupMembersModalComponent {
  readonly isOpen = input<boolean>(false);
  readonly members = input<ConversationParticipant[]>([]);
  readonly selfDid = input<string>('');
  readonly groupName = input<string | null>(null);

  readonly closed = output<void>();
  readonly renameGroup = output<string>();

  readonly isEditing = signal(false);
  editNameValue = '';

  constructor() {
    addIcons({ closeOutline, createOutline, checkmarkOutline });
  }

  startEditing(): void {
    this.editNameValue = this.groupName() || '';
    this.isEditing.set(true);
  }

  saveName(): void {
    this.renameGroup.emit(this.editNameValue);
    this.isEditing.set(false);
  }

  closeModal(): void {
    this.isEditing.set(false);
    this.closed.emit();
  }
}
