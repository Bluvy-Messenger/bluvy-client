import {
  Component, input, output,
  inject, signal, computed, effect,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { IonModal, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { searchOutline, close, arrowBack, locationOutline, checkmark } from 'ionicons/icons';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';


import { PhotonService } from '../../../core/place/photon.service';
import type { PlaceData } from '../../../core/place/place.types';
import { buildCartesUrl, isAllowedCartesUrl } from '../../../core/place/cartes-url.util';

const SEARCH_DEBOUNCE_MS = 350;

@Component({
  selector: 'app-place-picker-modal',
  imports: [IonModal, IonIcon, IonSpinner, TranslatePipe],
  templateUrl: './place-picker-modal.component.html',
  styleUrls: ['./place-picker-modal.component.scss'],
})
export class PlacePickerModalComponent {
  readonly isOpen = input<boolean>(false);
  readonly closed = output<void>();
  readonly placeSelected = output<PlaceData>();

  private photonSvc = inject(PhotonService);
  private i18n = inject(TranslateService);
  private sanitizer = inject(DomSanitizer);

  readonly query = signal('');
  readonly results = signal<PlaceData[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly selectedPlace = signal<PlaceData | null>(null);

  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  constructor() {
    addIcons({ searchOutline, close, arrowBack, locationOutline, checkmark });
    effect(() => {
      if (!this.isOpen()) {
        this.resetState();
      }
    });
  }

  readonly safePreviewUrl = computed<SafeResourceUrl | null>(() => {
    const place = this.selectedPlace();
    if (!place) return null;
    const url = buildCartesUrl(place);
    if (!isAllowedCartesUrl(url)) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  onQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);

    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }

    const trimmed = value.trim();
    if (!trimmed) {
      this.abortController?.abort();
      this.loading.set(false);
      this.error.set(false);
      this.results.set([]);
      return;
    }

    this.debounceHandle = setTimeout(() => {
      void this.runSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(q: string): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();

    this.loading.set(true);
    this.error.set(false);

    try {
      const places = await this.photonSvc.search(
        q,
        this.i18n.currentLang() ?? 'fr',
        12,
        this.abortController.signal,
      );
      this.results.set(places);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      this.error.set(true);
      this.results.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  selectPlace(place: PlaceData): void {
    this.selectedPlace.set(place);
  }

  cancelSelection(): void {
    this.selectedPlace.set(null);
  }

  confirmAndSend(): void {
    const place = this.selectedPlace();
    if (place) {
      this.placeSelected.emit(place);
      this.dismiss();
    }
  }

  dismiss(): void {
    this.resetState();
    this.closed.emit();
  }

  private resetState(): void {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.abortController?.abort();
    this.query.set('');
    this.results.set([]);
    this.loading.set(false);
    this.error.set(false);
    this.selectedPlace.set(null);
  }
}
