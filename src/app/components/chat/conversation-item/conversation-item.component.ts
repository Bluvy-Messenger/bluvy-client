import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { PresenceIndicatorComponent } from '../../ui/presence-indicator/presence-indicator.component';
import { UnreadBadgeComponent } from '../unread-badge/unread-badge.component';

@Component({
  selector: 'app-conversation-item',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './conversation-item.component.html',
  styleUrls: ['./conversation-item.component.scss'],
  imports: [AvatarComponent, PresenceIndicatorComponent, UnreadBadgeComponent],
})
export class ConversationItemComponent {
  @Input() avatarSrc: string | null = null;
  @Input() handle = '';
  @Input() name = '';
  @Input() preview = '';
  @Input() time = '';
  @Input() unreadCount = 0;
  @Input() online = false;
  @Output() open = new EventEmitter<void>();

  get displayPreview(): string {
    return this.preview || ('@' + this.handle);
  }
}
