import { Component, input, output, inject, signal, effect } from '@angular/core';
import { IonModal, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { TranslatePipe } from '@ngx-translate/core';

import { GiphyRepository } from '../../../core/giphy/giphy.repository';
import type { GiphyGifSummary } from '../../../core/giphy/giphy.types';

const SEARCH_DEBOUNCE_MS = 350;

@Component({
  selector: 'app-gif-picker',
  imports: [IonModal, IonIcon, IonSpinner, TranslatePipe],
  templateUrl: './gif-picker.component.html',
  styleUrls: ['./gif-picker.component.scss'],
})
export class GifPickerComponent {
  readonly isOpen = input<boolean>(false);
  readonly closed = output<void>();
  readonly gifSelected = output<GiphyGifSummary>();

  private giphyRepo = inject(GiphyRepository);

  readonly query   = signal('');
  readonly gifs    = signal<GiphyGifSummary[]>([]);
  readonly loading = signal(false);
  readonly error   = signal(false);

  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private lastQuery: string | null = null;

  constructor() {
    effect(() => {
      if (this.isOpen() && this.gifs().length === 0) {
        void this.loadTrending();
      }
    });
  }

  onQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);

    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      const trimmed = value.trim();
      void (trimmed ? this.runSearch(trimmed) : this.loadTrending());
    }, SEARCH_DEBOUNCE_MS);
  }

  private async loadTrending(): Promise<void> {
    const token = 'trending';
    this.lastQuery = token;
    this.loading.set(true);
    this.error.set(false);
    try {
      const gifs = await this.giphyRepo.getTrending();
      if (this.lastQuery !== token) return;
      this.gifs.set(gifs);
    } catch {
      if (this.lastQuery === token) this.error.set(true);
    } finally {
      if (this.lastQuery === token) this.loading.set(false);
    }
  }

  private async runSearch(q: string): Promise<void> {
    this.lastQuery = q;
    this.loading.set(true);
    this.error.set(false);
    try {
      const gifs = await this.giphyRepo.search(q);
      if (this.lastQuery !== q) return;
      this.gifs.set(gifs);
    } catch {
      if (this.lastQuery === q) this.error.set(true);
    } finally {
      if (this.lastQuery === q) this.loading.set(false);
    }
  }

  selectGif(gif: GiphyGifSummary): void {
    this.gifSelected.emit(gif);
    this.dismiss();
  }

  dismiss(): void {
    this.closed.emit();
  }
}
