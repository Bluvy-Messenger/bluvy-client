import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';

@Component({
  selector: 'app-unread-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `<span class="badge" [attr.aria-label]="'unread.count' | translate: { count }">{{ display }}</span>`,
  styleUrls: ['./unread-badge.component.scss'],
})
export class UnreadBadgeComponent {
  @Input() count = 0;

  get display(): string {
    return this.count > 99 ? '99+' : String(this.count);
  }
}
