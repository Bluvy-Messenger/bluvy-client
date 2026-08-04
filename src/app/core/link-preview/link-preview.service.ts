import { Injectable, inject } from '@angular/core';
import { LinkPreviewRepository } from './link-preview.repository';
import type { LinkPreviewMeta } from './link-preview.types';

@Injectable({ providedIn: 'root' })
export class LinkPreviewService {
  private repo = inject(LinkPreviewRepository);

  // Session-lifetime dedup caches — the backend already persists the real
  // cache (TTL'd), these just avoid redundant round-trips when the same URL
  // appears across multiple messages/re-renders in one app session.
  private previewCache = new Map<string, Promise<LinkPreviewMeta | null>>();
  private imageCache   = new Map<string, Promise<string | null>>();

  getPreview(url: string): Promise<LinkPreviewMeta | null> {
    let cached = this.previewCache.get(url);
    if (!cached) {
      cached = this.repo.fetchPreview(url).catch(() => null);
      this.previewCache.set(url, cached);
    }
    return cached;
  }

  // Resolves the proxy image path to a local object URL (blob:...) so the
  // template can bind it directly to an <img src>.
  getImageObjectUrl(relativeImagePath: string): Promise<string | null> {
    let cached = this.imageCache.get(relativeImagePath);
    if (!cached) {
      cached = this.repo.fetchImageBlob(relativeImagePath)
        .then(blob => URL.createObjectURL(blob))
        .catch(() => null);
      this.imageCache.set(relativeImagePath, cached);
    }
    return cached;
  }

  clear(): void {
    // Revoke all created Object URLs to release memory blobs
    this.imageCache.forEach(async (promise) => {
      try {
        const url = await promise;
        if (url) {
          URL.revokeObjectURL(url);
        }
      } catch { /* ignore */ }
    });
    this.previewCache.clear();
    this.imageCache.clear();
  }
}
