import { Injectable, inject } from '@angular/core';
import { AtprotoRepository } from '../auth/atproto.repository';
import { ApiClientService } from '../infrastructure/api-client.service';
import { toPopfeedReviewView } from './popfeed-review.mapper';
import type { PopfeedReviewUrlMatch } from './popfeed-review-url.util';
import type { PopfeedReviewView } from './popfeed-review.types';

const REVIEW_COLLECTION = 'social.popfeed.feed.review';

interface RawProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

@Injectable({ providedIn: 'root' })
export class PopfeedReviewRepository {
  private atprotoRepo = inject(AtprotoRepository);
  private apiClient   = inject(ApiClientService);

  // Session-lifetime dedup cache, mirroring BskyPostRepository/LinkPreviewService.
  private cache = new Map<string, Promise<PopfeedReviewView | null>>();

  getReview(match: PopfeedReviewUrlMatch): Promise<PopfeedReviewView | null> {
    const key = `${match.did}/${match.rkey}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.fetchReview(match);
      this.cache.set(key, cached);
    }
    return cached;
  }

  private async fetchReview(match: PopfeedReviewUrlMatch): Promise<PopfeedReviewView | null> {
    try {
      const pdsUrl = await this.atprotoRepo.resolveDidToPds(match.did);
      const recordUrl = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(match.did)}&collection=${REVIEW_COLLECTION}&rkey=${encodeURIComponent(match.rkey)}`;
      const record = await this.apiClient.get<{ uri: string; value: Record<string, unknown> }>(recordUrl, { skipAuth: true });

      const profileUrl = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(match.did)}`;
      const profile = await this.apiClient.get<RawProfile>(profileUrl, { skipAuth: true }).catch(() => ({ did: match.did, handle: match.did }));

      return toPopfeedReviewView(record.uri, record.value, profile);
    } catch {
      return null;
    }
  }
}
