import { Component, EventEmitter, Input, Output } from '@angular/core';
import { IonModal, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import type { ConversationParticipant } from '../../../core/conversation/conversation.types';

// Read-only member list for a group conversation, opened from the
// conversation header or the options popover. Follows the same standalone
// IonModal + isOpen/closed Input/Output pattern as NewChatModalComponent,
// styled with the app's theme tokens to match sidebar-list's contact rows.
@Component({
  selector: 'app-group-members-modal',
  standalone: true,
  imports: [
    IonModal, IonIcon,
    TranslatePipe,
    AvatarComponent,
  ],
  templateUrl: './group-members-modal.component.html',
  styleUrls: ['./group-members-modal.component.scss'],
})
export class GroupMembersModalComponent {
  @Input() isOpen = false;
  @Input() members: ConversationParticipant[] = [];
  @Input() selfDid = '';

  @Output() closed = new EventEmitter<void>();

  closeModal(): void {
    this.closed.emit();
  }
}
