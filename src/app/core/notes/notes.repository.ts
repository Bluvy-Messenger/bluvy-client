import { Injectable, inject } from '@angular/core';
import { Agent, AtUri } from '@atproto/api';
import { OAuthService } from '../auth/oauth.service';
import {
  NOTE_COLLECTION,
  type BluvyNoteRecord,
  type EncryptedNoteEnvelope,
} from './notes.types';

export interface PdsNoteRecordItem {
  rkey: string;
  cid: string;
  value: BluvyNoteRecord;
}

@Injectable({ providedIn: 'root' })
export class NotesRepository {
  private oauth = inject(OAuthService);

  private getAgent(): { agent: Agent; repo: string } | null {
    const session = this.oauth.session;
    if (!session || !session.sub) return null;
    const agent = new Agent(session.fetchHandler.bind(session));
    return { agent, repo: session.sub };
  }

  /**
   * Creates a new encrypted note record in the user's PDS repository.
   */
  async createRecord(envelope: EncryptedNoteEnvelope): Promise<{ uri: string; cid: string; rkey: string }> {
    const ctx = this.getAgent();
    if (!ctx) throw new Error('No active ATProto session');

    const record: BluvyNoteRecord = {
      $type: NOTE_COLLECTION,
      ...envelope,
    };

    const res = await ctx.agent.com.atproto.repo.createRecord({
      repo: ctx.repo,
      collection: NOTE_COLLECTION,
      record: record as unknown as Record<string, unknown>,
    });

    const rkey = new AtUri(res.data.uri).rkey;
    return {
      uri: res.data.uri,
      cid: res.data.cid,
      rkey,
    };
  }

  /**
   * Updates an existing note record on the user's PDS by rkey.
   */
  async putRecord(rkey: string, envelope: EncryptedNoteEnvelope): Promise<{ uri: string; cid: string }> {
    const ctx = this.getAgent();
    if (!ctx) throw new Error('No active ATProto session');

    const record: BluvyNoteRecord = {
      $type: NOTE_COLLECTION,
      ...envelope,
    };

    const res = await ctx.agent.com.atproto.repo.putRecord({
      repo: ctx.repo,
      collection: NOTE_COLLECTION,
      rkey,
      record: record as unknown as Record<string, unknown>,
    });

    return {
      uri: res.data.uri,
      cid: res.data.cid,
    };
  }

  /**
   * Deletes a note record from the user's PDS.
   */
  async deleteRecord(rkey: string): Promise<void> {
    const ctx = this.getAgent();
    if (!ctx) return;

    try {
      await ctx.agent.com.atproto.repo.deleteRecord({
        repo: ctx.repo,
        collection: NOTE_COLLECTION,
        rkey,
      });
    } catch {
      // Ignored if already deleted
    }
  }

  /**
   * Retrieves a single note record from the user's PDS by rkey.
   */
  async getRecord(rkey: string): Promise<PdsNoteRecordItem | null> {
    const ctx = this.getAgent();
    if (!ctx) return null;

    try {
      const res = await ctx.agent.com.atproto.repo.getRecord({
        repo: ctx.repo,
        collection: NOTE_COLLECTION,
        rkey,
      });

      return {
        rkey,
        cid: res.data.cid ?? '',
        value: res.data.value as unknown as BluvyNoteRecord,
      };
    } catch {
      return null;
    }
  }

  /**
   * Lists note records from the user's PDS with pagination.
   */
  async listRecords(cursor?: string, limit = 50): Promise<{ records: PdsNoteRecordItem[]; cursor?: string }> {
    const ctx = this.getAgent();
    if (!ctx) return { records: [] };

    try {
      const res = await ctx.agent.com.atproto.repo.listRecords({
        repo: ctx.repo,
        collection: NOTE_COLLECTION,
        limit,
        cursor,
      });

      const records: PdsNoteRecordItem[] = res.data.records.map(r => ({
        rkey: new AtUri(r.uri).rkey,
        cid: r.cid,
        value: r.value as unknown as BluvyNoteRecord,
      }));

      return {
        records,
        cursor: res.data.cursor,
      };
    } catch {
      return { records: [] };
    }
  }
}
