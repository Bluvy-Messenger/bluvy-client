import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-presence-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="presence" [class.presence--online]="online"></span>`,
  styleUrls: ['./presence-indicator.component.scss'],
})
export class PresenceIndicatorComponent {
  @Input() online = false;
}
