import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../infrastructure/api-client.service';
import type { LinkPreviewMeta } from './link-preview.types';

@Injectable({ providedIn: 'root' })
export class LinkPreviewRepository {
  private apiClient = inject(ApiClientService);

  async fetchPreview(url: string): Promise<LinkPreviewMeta> {
    const raw = await this.apiClient.get<{ data: LinkPreviewMeta }>('/v1/link-preview', {
      params: { url },
    });
    return raw.data;
  }

  async fetchImageBlob(relativeImagePath: string): Promise<Blob> {
    return this.apiClient.getBlob(relativeImagePath);
  }
}
