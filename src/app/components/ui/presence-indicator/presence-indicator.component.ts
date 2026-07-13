import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';

@Component({
  selector: 'app-presence-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `<span
    class="presence"
    [class.presence--online]="online"
    role="img"
    [attr.aria-label]="(online ? 'presence.online' : 'presence.offline') | translate"
  ></span>`,
  styleUrls: ['./presence-indicator.component.scss'],
})
export class PresenceIndicatorComponent {
  @Input() online = false;
}
