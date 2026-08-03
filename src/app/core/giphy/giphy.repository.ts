import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../infrastructure/api-client.service';
import type { GiphyGifSummary } from './giphy.types';

@Injectable({ providedIn: 'root' })
export class GiphyRepository {
  private apiClient = inject(ApiClientService);

  async getTrending(offset = 0): Promise<GiphyGifSummary[]> {
    const res = await this.apiClient.get<{ data: GiphyGifSummary[] }>('/v1/giphy/trending', {
      params: { limit: '24', offset: String(offset) },
    });
    return res.data;
  }

  async search(query: string, offset = 0): Promise<GiphyGifSummary[]> {
    const res = await this.apiClient.get<{ data: GiphyGifSummary[] }>('/v1/giphy/search', {
      params: { q: query, limit: '24', offset: String(offset) },
    });
    return res.data;
  }
}
