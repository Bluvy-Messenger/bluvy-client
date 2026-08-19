import { Component, input, computed } from '@angular/core';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';

@Component({
  selector: 'app-unread-badge',
  imports: [TranslatePipe],
  template: `<span class="badge" [attr.aria-label]="'unread.count' | translate: { count: count() }">{{ display() }}</span>`,
  styleUrls: ['./unread-badge.component.scss'],
})
export class UnreadBadgeComponent {
  readonly count = input<number>(0);

  readonly display = computed(() => {
    const c = this.count();
    return c > 99 ? '99+' : String(c);
  });
}
