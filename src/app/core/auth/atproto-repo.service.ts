import { Injectable, inject } from '@angular/core';
import { Agent } from '@atproto/api';
import { OAuthService } from './oauth.service';
import { environment } from '../../../environments/environment';
import type { EmbedPreferencesRecord } from '../embed/embed-preferences.types';

const EMBED_PREFERENCES_COLLECTION = 'com.bluvy.preferences.embeds';

@Injectable({ providedIn: 'root' })
export class AtprotoRepoService {
  private oauth = inject(OAuthService);

  private getAgent(): Agent | null {
    const session = this.oauth.session;
    if (!session) return null;
    return new Agent(session.fetchHandler.bind(session));
  }

  /**
   * Publishes or updates the com.bluvy.declaration record in the user's ATProto repository.
   */
  async publishDeclaration(
    currentKey: Uint8Array,
    showButtonTo: 'none' | 'usersIFollow' | 'everyone' = 'everyone'
  ): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const repo = this.oauth.session.sub;
    const cleanOrigin = window.location.origin.endsWith('/') ? window.location.origin.slice(0, -1) : window.location.origin;
    const messageMeUrl = environment.production ? 'https://bluvy.app/message' : `${cleanOrigin}/message`;

    const record = {
      version: environment.version,
      currentKey, // Uint8Array is serialized as bytes in DAG-CBOR
      messageMe: {
        showButtonTo,
        messageMeUrl
      }
    };

    await agent.com.atproto.repo.putRecord({
      repo,
      collection: 'com.bluvy.declaration',
      rkey: 'self',
      record
    });
  }

  /**
   * Deletes the com.bluvy.declaration record from the user's ATProto repository.
   */
  async deleteDeclaration(): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      return; // No active session to delete from
    }

    const repo = this.oauth.session.sub;
    try {
      await agent.com.atproto.repo.deleteRecord({
        repo,
        collection: 'com.bluvy.declaration',
        rkey: 'self'
      });
    } catch (err) {
      // Ignore if record already deleted or doesn't exist
    }
  }

  /**
   * Fetches the com.bluvy.preferences.embeds record from the user's ATProto
   * repository. Returns null both when the record doesn't exist yet (new
   * account, never configured) and when it can't be reached (network/PDS
   * failure) — callers must never distinguish the two as "allow everything"
   * vs "deny everything"; both fall back to cache-then-defaults.
   */
  async getEmbedPreferences(): Promise<EmbedPreferencesRecord | null> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) return null;

    try {
      const res = await agent.com.atproto.repo.getRecord({
        repo: this.oauth.session.sub,
        collection: EMBED_PREFERENCES_COLLECTION,
        rkey: 'self',
      });
      return res.data.value as unknown as EmbedPreferencesRecord;
    } catch {
      return null;
    }
  }

  /**
   * Writes the full com.bluvy.preferences.embeds record to the user's
   * ATProto repository. Always the complete record — putRecord replaces the
   * whole value, so partial patches would silently drop other providers.
   */
  async putEmbedPreferences(record: EmbedPreferencesRecord): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    await agent.com.atproto.repo.putRecord({
      repo: this.oauth.session.sub,
      collection: EMBED_PREFERENCES_COLLECTION,
      rkey: 'self',
      record: record as unknown as Record<string, unknown>,
    });
  }

  /**
   * Programmatically sends a direct message to a Bluesky user.
   */
  async sendBlueskyDM(recipientDid: string, text: string): Promise<void> {
    const agent = this.getAgent();
    if (!agent) {
      throw new Error('No active ATProto session');
    }

    // 1. Get or create the conversation ID for the recipient
    const convoRes = await agent.call(
      'chat.bsky.convo.getConvoForMembers',
      { members: [recipientDid] },
      undefined,
      {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat'
        }
      }
    );

    const convoId = (convoRes.data as any)?.convo?.id;
    if (!convoId) {
      throw new Error('Could not establish Bluesky DM channel');
    }

    // 2. Send the invitation message to the conversation
    await agent.call(
      'chat.bsky.convo.sendMessage',
      undefined,
      {
        convoId,
        message: { text }
      },
      {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat'
        }
      }
    );
  }
}
