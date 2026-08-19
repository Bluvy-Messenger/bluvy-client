import { Component, input, computed, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { mapOutline, openOutline, locationOutline, alertCircleOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import type { PlaceData } from '../../../core/place/place.types';
import { buildCartesUrl, isAllowedCartesUrl, validatePlaceData } from '../../../core/place/cartes-url.util';

@Component({
  selector: 'app-place-embed',
  imports: [IonIcon, TranslatePipe],
  templateUrl: './place-embed.component.html',
  styleUrls: ['./place-embed.component.scss'],
  host: {
    '[class.place-embed--mine]': 'isMine()',
  },
})
export class PlaceEmbedComponent {
  readonly place = input.required<PlaceData>();
  readonly isMine = input<boolean>(false);

  private sanitizer = inject(DomSanitizer);

  constructor() {
    addIcons({ mapOutline, openOutline, locationOutline, alertCircleOutline });
  }

  readonly isValid = computed(() => validatePlaceData(this.place()));

  readonly rawCartesUrl = computed<string | null>(() => {
    if (!this.isValid()) return null;
    const url = buildCartesUrl(this.place());
    return isAllowedCartesUrl(url) ? url : null;
  });

  readonly safeCartesUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.rawCartesUrl();
    if (!url) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  openInCartesApp(event: MouseEvent): void {
    event.stopPropagation();
    const url = this.rawCartesUrl();
    if (url && isAllowedCartesUrl(url)) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
}
