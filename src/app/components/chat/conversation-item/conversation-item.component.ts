import { Component, input, output, computed } from '@angular/core';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { PresenceIndicatorComponent } from '../../ui/presence-indicator/presence-indicator.component';
import { UnreadBadgeComponent } from '../unread-badge/unread-badge.component';

@Component({
  selector: 'app-conversation-item',
  templateUrl: './conversation-item.component.html',
  styleUrls: ['./conversation-item.component.scss'],
  imports: [AvatarComponent, PresenceIndicatorComponent, UnreadBadgeComponent],
})
export class ConversationItemComponent {
  readonly avatarSrc = input<string | null>(null);
  readonly handle = input<string>('');
  readonly name = input<string>('');
  readonly preview = input<string>('');
  readonly time = input<string>('');
  readonly unreadCount = input<number>(0);
  readonly online = input<boolean>(false);
  readonly open = output<void>();

  readonly displayPreview = computed(() => {
    return this.preview() || ('@' + this.handle());
  });

  onItemClick(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement | null;
    target?.blur();
    this.open.emit();
  }
}
