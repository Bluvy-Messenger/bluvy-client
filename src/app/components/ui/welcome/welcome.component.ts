import { Component, Input, computed } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';

@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [IonIcon, TranslatePipe],
  template: `
    <div class="shell__welcome">
      <ion-icon [name]="iconName()"></ion-icon>
      <p>{{ messageKey() | translate }}</p>
    </div>
  `,
  styles: [`
    .shell__welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: var(--space-3);
      color: var(--color-text-secondary);

      ion-icon {
        font-size: 44px;
        opacity: 0.25;
      }

      p {
        font-family: var(--font-sans);
        font-size: var(--text-base);
        color: var(--color-text-secondary);
        margin: 0;
      }
    }
  `]
})
export class WelcomeComponent {
  @Input() section: 'conversations' | 'contacts' = 'conversations';

  readonly iconName = computed(() => {
    return this.section === 'contacts' ? 'people-outline' : 'chatbubble-outline';
  });

  readonly messageKey = computed(() => {
    return this.section === 'contacts' ? 'conversations.contacts.welcome' : 'conversations.welcome';
  });
}
