import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AtpAgent } from '@atproto/api';
import { ApiClientService } from '../infrastructure/api-client.service';
import type { AtprotoLoginResult, DidDocument } from './atproto.service';
import type { BlueskyProfile } from '../contact/contact.types';

@Injectable({ providedIn: 'root' })
export class AtprotoRepository {
  private readonly apiClient = inject(ApiClientService);

  async login(handle: string, password: string): Promise<AtprotoLoginResult> {
    const did    = await this.resolveHandleToDid(handle);
    const pdsUrl = await this.resolveDidToPds(did);

    const agent  = new AtpAgent({ service: pdsUrl });
    const result = await agent.login({ identifier: handle, password });

    return {
      accessJwt: result.data.accessJwt,
      did:       result.data.did,
      handle:    result.data.handle,
    };
  }

  async resolveDidToPds(did: string): Promise<string> {
    const didDocUrl = this.buildDidDocUrl(did);

    let didDoc: DidDocument;
    try {
      didDoc = await this.apiClient.get<DidDocument>(didDocUrl, { skipAuth: true });
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        throw new Error(`DID document not found for: ${did}`);
      }
      throw new Error(`Could not reach DID resolver for: ${did}`);
    }

    const pdsService = didDoc.service?.find(s => s.type === 'AtprotoPersonalDataServer');

    if (!pdsService?.serviceEndpoint) {
      throw new Error('No PDS endpoint found in DID document.');
    }

    if (!pdsService.serviceEndpoint.startsWith('https://')) {
      throw new Error('PDS endpoint must use HTTPS.');
    }

    return pdsService.serviceEndpoint;
  }

  private async resolveHandleToDid(handle: string): Promise<string> {
    const url = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;

    let data: { did: string };
    try {
      data = await this.apiClient.get<{ did: string }>(url, { skipAuth: true });
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        throw new Error(`Handle not found: ${handle}`);
      }
      throw new Error(`Could not reach identity resolver for handle: ${handle}`);
    }

    if (!data.did) throw new Error(`Invalid identity response for handle: ${handle}`);
    return data.did;
  }

  async getFollows(userDid: string): Promise<BlueskyProfile[]> {
    return this.fetchBlueskyGraph('getFollows', 'follows', userDid);
  }

  async getFollowers(userDid: string): Promise<BlueskyProfile[]> {
    return this.fetchBlueskyGraph('getFollowers', 'followers', userDid);
  }

  private async fetchBlueskyGraph(
    method: 'getFollows' | 'getFollowers',
    listKey: 'follows' | 'followers',
    userDid: string,
  ): Promise<BlueskyProfile[]> {
    const all: BlueskyProfile[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const url = new URL(`https://public.api.bsky.app/xrpc/app.bsky.graph.${method}`);
      url.searchParams.set('actor', userDid);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);

      let page: Record<string, unknown>;
      try {
        page = await this.apiClient.get<Record<string, unknown>>(url.toString(), { skipAuth: true });
      } catch {
        break;
      }

      const actors = page[listKey];
      if (!Array.isArray(actors)) break;

      for (const actor of actors) {
        if (typeof actor !== 'object' || actor === null) continue;
        const a = actor as Record<string, unknown>;
        if (typeof a['did'] !== 'string' || typeof a['handle'] !== 'string') continue;
        all.push({
          did:         a['did'] as string,
          handle:      a['handle'] as string,
          displayName: typeof a['displayName'] === 'string' ? a['displayName'] : null,
          avatarUrl:   typeof a['avatar']      === 'string' ? a['avatar']      : null,
        });
      }

      cursor = typeof page['cursor'] === 'string' ? page['cursor'] : undefined;
      pages++;
    } while (cursor && pages < 50);

    return all;
  }

  private buildDidDocUrl(did: string): string {
    if (did.startsWith('did:plc:')) {
      return `https://plc.directory/${did}`;
    }

    throw new Error('Unsupported DID method.');
  }
}
