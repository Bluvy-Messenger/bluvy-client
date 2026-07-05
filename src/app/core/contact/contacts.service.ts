import { Injectable, inject } from '@angular/core';
import { ContactRepository } from './contact.repository';
import { AtprotoRepository } from '../auth/atproto.repository';
import { chunkArray } from '../infrastructure/array.util';
import type { BlueskyProfile, Contact, ContactSyncResult } from './contact.types';

export type { Contact, BlueskyProfile, ContactSyncResult } from './contact.types';

const CACHE_TTL_MS   =  5 * 60 * 1000;  // in-memory hot TTL
const STORAGE_TTL_MS = 60 * 60 * 1000;  // localStorage TTL across restarts

@Injectable({ providedIn: 'root' })
export class ContactsService {
  private repo    = inject(ContactRepository);
  private atproto = inject(AtprotoRepository);

  private _cache:     ContactSyncResult | null = null;
  private _cacheUser: string | null = null;

  // Returns any cached result (in-memory or localStorage) regardless of TTL.
  // Used for stale-while-revalidate: show data instantly, sync in background.
  getCached(userDid: string): ContactSyncResult | null {
    if (this._cache && this._cacheUser === userDid) return this._cache;
    return this.loadFromStorage(userDid);
  }

  async sync(userDid: string, forceRefresh = false): Promise<ContactSyncResult> {
    if (!forceRefresh &&
        this._cache &&
        this._cacheUser === userDid &&
        Date.now() - this._cache.syncedAt < CACHE_TTL_MS) {
      return this._cache;
    }

    if (!forceRefresh) {
      const stored = this.loadFromStorage(userDid);
      if (stored && Date.now() - stored.syncedAt < STORAGE_TTL_MS) {
        this._cache     = stored;
        this._cacheUser = userDid;
        return stored;
      }
    }

    const [follows, followers] = await Promise.all([
      this.atproto.getFollows(userDid),
      this.atproto.getFollowers(userDid),
    ]);

    const followerSet    = new Set(followers.map(f => f.did));
    const mutualProfiles = follows.filter(f => followerSet.has(f.did));

    const mutualDids = mutualProfiles.map(p => p.did);

    const bluvyDids     = new Set<string>();
    const bluvyProfiles = new Map<string, Contact>();

    if (mutualDids.length > 0) {
      const chunks = chunkArray(mutualDids, 500);
      for (const chunk of chunks) {
        const resolved = await this.repo.resolve(chunk);
        for (const account of resolved.data) {
          bluvyDids.add(account.did);
          bluvyProfiles.set(account.did, account);
        }
      }
    }

    const bluvyContacts:   Contact[]        = [];
    const blueskyContacts: BlueskyProfile[] = [];

    for (const profile of mutualProfiles) {
      if (bluvyDids.has(profile.did)) {
        bluvyContacts.push(bluvyProfiles.get(profile.did)!);
      } else {
        blueskyContacts.push(profile);
      }
    }

    bluvyContacts.sort((a, b)   => a.handle.localeCompare(b.handle));
    blueskyContacts.sort((a, b) => a.handle.localeCompare(b.handle));

    const result: ContactSyncResult = { bluvyContacts, blueskyContacts, syncedAt: Date.now() };
    this._cache     = result;
    this._cacheUser = userDid;
    this.saveToStorage(userDid, result);
    return result;
  }

  reset(): void {
    if (this._cacheUser) {
      try { localStorage.removeItem(this.storageKey(this._cacheUser)); } catch { /* ignore */ }
    }
    this._cache     = null;
    this._cacheUser = null;
  }

  private storageKey(userDid: string): string {
    return `bluvy_contacts_${userDid}`;
  }

  private loadFromStorage(userDid: string): ContactSyncResult | null {
    try {
      const raw = localStorage.getItem(this.storageKey(userDid));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ContactSyncResult;
      if (typeof parsed['syncedAt'] !== 'number' ||
          !Array.isArray(parsed['bluvyContacts']) ||
          !Array.isArray(parsed['blueskyContacts'])) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveToStorage(userDid: string, result: ContactSyncResult): void {
    try {
      localStorage.setItem(this.storageKey(userDid), JSON.stringify(result));
    } catch {
      // Storage full or unavailable — no-op
    }
  }
}
