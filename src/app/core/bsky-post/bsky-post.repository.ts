import { Injectable, inject } from '@angular/core';
import type { AppBskyFeedDefs } from '@atproto/api';
import { AtprotoRepoService } from '../auth/atproto-repo.service';
import { AtprotoRepository } from '../auth/atproto.repository';
import { ApiClientService } from '../infrastructure/api-client.service';
import { toBskyPostView } from './bsky-post.mapper';
import type { BskyPostUrlMatch } from './bsky-post-url.util';
import type { BskyPostView } from './bsky-post.types';

// app.bsky.* query lexicons live on the AppView, not the PDS -- same reason
// sendBlueskyDM() proxies to did:web:api.bsky.chat for chat.bsky.convo.*.
// Not every PDS proxies app.bsky.* reads the same way (confirmed: a 401 from
// a third-party PDS here), so this is a best-effort first attempt only --
// see fetchPost()'s fallback to the public AppView below.
const APPVIEW_PROXY_HEADER = { 'atproto-proxy': 'did:web:api.bsky.app#bsky_appview' };

@Injectable({ providedIn: 'root' })
export class BskyPostRepository {
  private atprotoRepoSvc  = inject(AtprotoRepoService);
  private atprotoRepo     = inject(AtprotoRepository);
  private apiClient       = inject(ApiClientService);

  // Session-lifetime dedup cache, mirroring LinkPreviewService's pattern --
  // the same post link can appear across multiple messages/re-renders.
  private cache = new Map<string, Promise<BskyPostView | null>>();

  getPost(match: BskyPostUrlMatch): Promise<BskyPostView | null> {
    const key = `${match.handleOrDid}/${match.rkey}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.fetchPost(match);
      this.cache.set(key, cached);
    }
    return cached;
  }

  private async fetchPost(match: BskyPostUrlMatch): Promise<BskyPostView | null> {
    // Always resolve to a DID before building the AT-URI -- a handle-authority
    // AT-URI relies on the receiving service resolving it on the fly, which
    // isn't reliable across every PDS/AppView combination (confirmed by a
    // real 401/failure using a handle-authority URI against a third-party PDS).
    let did = match.handleOrDid;
    if (!did.startsWith('did:')) {
      try {
        did = await this.atprotoRepo.resolveHandleToDid(match.handleOrDid);
      } catch {
        return null;
      }
    }
    const atUri = `at://${did}/app.bsky.feed.post/${match.rkey}`;

    const viaAgent = await this.fetchViaAuthenticatedAgent(atUri);
    if (viaAgent) return viaAgent;

    // Some PDSes (self-hosted or third-party, e.g. eurosky.social) reject or
    // don't support proxying app.bsky.* reads for this OAuth session -- fall
    // back to the public, unauthenticated AppView (same host already used by
    // AtprotoRepository.getFollows/resolveHandleToDid elsewhere in this app).
    // Only downside: no viewer state, so the like button starts unliked even
    // if the user already liked the post from elsewhere.
    return this.fetchViaPublicAppView(atUri);
  }

  private async fetchViaAuthenticatedAgent(atUri: string): Promise<BskyPostView | null> {
    const agent = this.atprotoRepoSvc.getAgent();
    if (!agent) return null;

    try {
      const res = await agent.app.bsky.feed.getPosts(
        { uris: [atUri] },
        { headers: APPVIEW_PROXY_HEADER },
      );
      const raw = res.data.posts[0] as AppBskyFeedDefs.PostView | undefined;
      return raw ? toBskyPostView(raw) : null;
    } catch {
      return null;
    }
  }

  private async fetchViaPublicAppView(atUri: string): Promise<BskyPostView | null> {
    try {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`;
      const data = await this.apiClient.get<{ posts: AppBskyFeedDefs.PostView[] }>(url, { skipAuth: true });
      const raw = data.posts[0];
      return raw ? toBskyPostView(raw) : null;
    } catch {
      return null;
    }
  }
}
