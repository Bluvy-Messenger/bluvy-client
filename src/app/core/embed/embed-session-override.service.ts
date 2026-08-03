import { Injectable, signal } from '@angular/core';

// In-memory only — "load this once" never touches the local cache or the PDS
// record, and is forgotten on app restart. Kept as a distinct service from
// EmbedPreferencesService so the two persistence paths can never merge.
@Injectable({ providedIn: 'root' })
export class EmbedSessionOverrideService {
  private loadedOnce = signal<ReadonlySet<string>>(new Set());

  isLoadedOnce(sourceUrl: string): boolean {
    return this.loadedOnce().has(sourceUrl);
  }

  markLoadedOnce(sourceUrl: string): void {
    const next = new Set(this.loadedOnce());
    next.add(sourceUrl);
    this.loadedOnce.set(next);
  }

  // Called when leaving a conversation -- "load this once" means for the
  // current visit, not for the rest of the app session.
  clear(): void {
    this.loadedOnce.set(new Set());
  }
}
