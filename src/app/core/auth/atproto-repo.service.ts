import { Injectable, inject } from '@angular/core';
import { Agent, AtUri, RichText } from '@atproto/api';
import { OAuthService } from './oauth.service';
import { environment } from '../../../environments/environment';
import type { EmbedPreferencesRecord } from '../embed/embed-preferences.types';

const EMBED_PREFERENCES_COLLECTION = 'com.bluvy.preferences.embeds';
const EMOJI_PREFERENCES_COLLECTION = 'com.bluvy.preferences.emojis';
const APP_SETTINGS_PREFERENCES_COLLECTION = 'com.bluvy.preferences.app';
const DECLARATION_COLLECTION = 'com.bluvy.declaration';

// Single source of truth for the URL published in com.bluvy.declaration --
// always bluvy.app, dev included (see publishDeclaration), so this is also
// what KeyPackageService.syncDeclaration() checks the live PDS record
// against when verifying it hasn't drifted (e.g. a stale dev-origin URL
// published before this constant existed).
export const BLUVY_MESSAGE_URL = 'https://bluvy.app/message';

export interface BluvyDeclarationRecord {
  version?: string;
  messageMe?: {
    showButtonTo?: string;
    messageMeUrl?: string;
  };
}

export interface EmojiPreferencesRecord {
  $type?: typeof EMOJI_PREFERENCES_COLLECTION;
  emojis: string[];
  updatedAt: string;
}

export interface AppSettingsRecord {
  $type?: typeof APP_SETTINGS_PREFERENCES_COLLECTION;
  theme?: {
    mode?: string;
    palette?: string;
    darkStyle?: string;
    accent?: string;
    fontFamily?: string;
    fontSize?: string;
  };
  locale?: string;
  notifications?: {
    inAppEnabled?: boolean;
    pushEnabled?: boolean;
  };
  mutedConversationIds?: string[];
  blockedContactDids?: string[];
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class AtprotoRepoService {
  private oauth = inject(OAuthService);

  // Exposed (not just internal) so sibling repositories (e.g. bsky-post.repository.ts)
  // can issue their own agent.app.bsky.* calls without duplicating session wiring.
  getAgent(): Agent | null {
    const session = this.oauth.session;
    if (!session) return null;
    return new Agent(session.fetchHandler.bind(session));
  }

  /**
   * Publishes or updates the com.bluvy.declaration record in the user's ATProto repository.
   *
   * showButtonTo values must match what bsky-app's BluvyButton reads
   * (bsky-app/src/state/queries/bluvy.ts) -- 'mutual' means mutual followers
   * with the profile owner, same population as this app's "contacts".
   */
  async publishDeclaration(
    currentKey: Uint8Array,
    showButtonTo: 'nothing' | 'mutual' | 'everyone' = 'everyone'
  ): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const repo = this.oauth.session.sub;
    // Always bluvy.app, even in dev: this URL is published publicly on the
    // user's PDS and read by third-party clients (e.g. bsky-app), which have
    // no notion of "this dev server's origin" -- a loopback URL here would be
    // dead on arrival for anyone but the developer's own machine.
    const messageMeUrl = BLUVY_MESSAGE_URL;

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
      collection: DECLARATION_COLLECTION,
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
        collection: DECLARATION_COLLECTION,
        rkey: 'self'
      });
    } catch (err) {
      // Ignore if record already deleted or doesn't exist
    }
  }

  /**
   * Fetches the com.bluvy.declaration record from the user's ATProto
   * repository. Returns null both when the record doesn't exist yet and when
   * it can't be reached (network/PDS failure) -- callers fall back to
   * whatever they already have cached locally.
   */
  async getDeclaration(): Promise<BluvyDeclarationRecord | null> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) return null;

    try {
      const res = await agent.com.atproto.repo.getRecord({
        repo: this.oauth.session.sub,
        collection: DECLARATION_COLLECTION,
        rkey: 'self',
      });
      return res.data.value as unknown as BluvyDeclarationRecord;
    } catch {
      return null;
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
   * Fetches the com.bluvy.preferences.emojis record from the user's ATProto repository.
   */
  async getEmojiPreferences(): Promise<EmojiPreferencesRecord | null> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) return null;

    try {
      const res = await agent.com.atproto.repo.getRecord({
        repo: this.oauth.session.sub,
        collection: EMOJI_PREFERENCES_COLLECTION,
        rkey: 'self',
      });
      return res.data.value as unknown as EmojiPreferencesRecord;
    } catch {
      return null;
    }
  }

  /**
   * Writes the com.bluvy.preferences.emojis record to the user's ATProto repository.
   */
  async putEmojiPreferences(emojis: string[]): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const record: EmojiPreferencesRecord = {
      $type: EMOJI_PREFERENCES_COLLECTION,
      emojis,
      updatedAt: new Date().toISOString(),
    };

    await agent.com.atproto.repo.putRecord({
      repo: this.oauth.session.sub,
      collection: EMOJI_PREFERENCES_COLLECTION,
      rkey: 'self',
      record: record as unknown as Record<string, unknown>,
    });
  }

  /**
   * Fetches the com.bluvy.preferences.app record from the user's ATProto repository.
   */
  async getAppSettingsPreferences(): Promise<AppSettingsRecord | null> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) return null;

    try {
      const res = await agent.com.atproto.repo.getRecord({
        repo: this.oauth.session.sub,
        collection: APP_SETTINGS_PREFERENCES_COLLECTION,
        rkey: 'self',
      });
      return res.data.value as unknown as AppSettingsRecord;
    } catch {
      return null;
    }
  }

  /**
   * Writes the com.bluvy.preferences.app record to the user's ATProto repository.
   */
  async putAppSettingsPreferences(record: AppSettingsRecord): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const payload: AppSettingsRecord = {
      ...record,
      $type: APP_SETTINGS_PREFERENCES_COLLECTION,
      updatedAt: new Date().toISOString(),
    };

    await agent.com.atproto.repo.putRecord({
      repo: this.oauth.session.sub,
      collection: APP_SETTINGS_PREFERENCES_COLLECTION,
      rkey: 'self',
      record: payload as unknown as Record<string, unknown>,
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

  /**
   * Creates an app.bsky.feed.like record for the given post, returning the
   * new like record's own URI (needed later to unlike). Raw createRecord --
   * not agent.like() -- because getAgent() builds Agent from a bound fetch
   * function, so Agent's sessionManager.did is always undefined and its
   * convenience methods (which read accountDid) would throw "Not logged in"
   * even with a fully valid session.
   */
  async likePost(uri: string, cid: string): Promise<string> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const res = await agent.com.atproto.repo.createRecord({
      repo: this.oauth.session.sub,
      collection: 'app.bsky.feed.like',
      record: {
        $type: 'app.bsky.feed.like',
        subject: { uri, cid },
        createdAt: new Date().toISOString(),
      },
    });
    return res.data.uri;
  }

  /**
   * Deletes a previously created like record.
   */
  async unlikePost(likeUri: string): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    await agent.com.atproto.repo.deleteRecord({
      repo: this.oauth.session.sub,
      collection: 'app.bsky.feed.like',
      rkey: new AtUri(likeUri).rkey,
    });
  }

  /**
   * Creates an app.bsky.feed.repost record (a plain "boost" -- no text, no
   * new post). Returns the new repost record's own URI, needed to un-repost.
   */
  async repostPost(uri: string, cid: string): Promise<string> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const res = await agent.com.atproto.repo.createRecord({
      repo: this.oauth.session.sub,
      collection: 'app.bsky.feed.repost',
      record: {
        $type: 'app.bsky.feed.repost',
        subject: { uri, cid },
        createdAt: new Date().toISOString(),
      },
    });
    return res.data.uri;
  }

  /**
   * Deletes a previously created repost record.
   */
  async unrepostPost(repostUri: string): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    await agent.com.atproto.repo.deleteRecord({
      repo: this.oauth.session.sub,
      collection: 'app.bsky.feed.repost',
      rkey: new AtUri(repostUri).rkey,
    });
  }

  /**
   * Creates an app.bsky.feed.post record quoting another post (embed.record).
   * Runs the text through RichText.detectFacets() first, so @mentions,
   * hyperlinks, and #hashtags typed in the comment become real, correctly
   * byte-indexed facets (mentions resolved to DIDs via a raw
   * com.atproto.identity.resolveHandle call, which -- unlike agent.like()/
   * agent.post() -- doesn't depend on the broken accountDid/session.did, so
   * it works fine with the Agent this.getAgent() builds).
   */
  async quotePost(text: string, quoted: { uri: string; cid: string }): Promise<void> {
    const agent = this.getAgent();
    if (!agent || !this.oauth.session?.sub) {
      throw new Error('No active ATProto session');
    }

    const richText = new RichText({ text });
    await richText.detectFacets(agent);

    await agent.com.atproto.repo.createRecord({
      repo: this.oauth.session.sub,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: richText.text,
        facets: richText.facets,
        createdAt: new Date().toISOString(),
        embed: {
          $type: 'app.bsky.embed.record',
          record: { uri: quoted.uri, cid: quoted.cid },
        },
      },
    });
  }
}
