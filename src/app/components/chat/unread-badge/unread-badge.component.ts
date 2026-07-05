import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-unread-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge">{{ display }}</span>`,
  styleUrls: ['./unread-badge.component.scss'],
})
export class UnreadBadgeComponent {
  @Input() count = 0;

  get display(): string {
    return this.count > 99 ? '99+' : String(this.count);
  }
}
