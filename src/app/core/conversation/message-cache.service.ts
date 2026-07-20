import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import type { IKeyStore, IMessageStore, EncryptedCacheRecord } from './cache/message-cache.types';
import { WebKeyStore }        from './cache/web-key-store';
import { WebMessageStore }    from './cache/web-message-store';
import { NativeKeyStore }     from './cache/native-key-store';
import { NativeMessageStore } from './cache/native-message-store';

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import type { CachedMessage, MessageCacheReadResult } from './conversation.types';

export type { CachedMessage, MessageCacheReadResult } from './conversation.types';

@Injectable({ providedIn: 'root' })
export class MessageCacheService {
  private keyStore!: IKeyStore;
  private msgStore!: IMessageStore;

  private readonly _stored = new Subject<CachedMessage>();
  readonly stored$: Observable<CachedMessage> = this._stored.asObservable();

  // Tracks the scope for which the stores are initialized.
  // null = not yet initialized; non-null = initialized for that scope.
  // Scope changes (different user or device) trigger full re-initialization.
  private initializedScope: string | null = null;

  // In-flight initialization, shared across concurrent callers. Without this,
  // two near-simultaneous calls (e.g. SyncService's background backfill and a
  // conversation page opening) can both pass the initializedScope check before
  // either sets it, each build their own NativeMessageStore/SQLiteConnection,
  // and race to createConnection() on the same native 'skychat-cache' DB — the
  // loser throws "Connection skychat-cache already exists".
  private initPromise: Promise<void> | null = null;

  async initialize(userDid: string, deviceId: string): Promise<void> {
    const scope = `cache:${userDid}:${deviceId}`;
    if (this.initializedScope === scope) return;

    if (this.initPromise) {
      await this.initPromise.catch(() => {});
      return this.initialize(userDid, deviceId);
    }

    this.initPromise = (async () => {
      const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
      if (Capacitor.isNativePlatform()) {
        this.keyStore = new NativeKeyStore(); // Android Keystore / iOS Keychain
        this.msgStore = new NativeMessageStore(sanitizedDid);
      } else {
        this.keyStore = new WebKeyStore(sanitizedDid);    // WebCrypto + IndexedDB
        this.msgStore = new WebMessageStore(sanitizedDid);
      }

      // Sequential: WebMessageStore.initialize() creates the IDB schema first
      // so WebKeyStore.initialize() finds the DB already set up.
      await this.msgStore.initialize();
      await this.keyStore.initialize(scope);
      this.initializedScope = scope;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async clearAllForUser(userDid: string): Promise<void> {
    const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
    
    if (Capacitor.isNativePlatform()) {
      try {
        const sqlite = new SQLiteConnection(CapacitorSQLite);
        await sqlite.checkConnectionsConsistency().catch(() => {});
        const dbName = `skychat-cache-${sanitizedDid}`;
        const isConn = await sqlite.isConnection(dbName, false);
        if (isConn.result) {
          const conn = await sqlite.retrieveConnection(dbName, false);
          await conn.delete().catch(() => {});
        } else {
          const conn = await sqlite.createConnection(dbName, false, 'no-encryption', 4, false);
          await conn.delete().catch(() => {});
        }
      } catch (err) {
        console.error('[MessageCacheService] clearAllForUser SQLite error:', err);
      }
    } else {
      const dbName = `skychat-message-cache-${sanitizedDid}`;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    }

    if (this.initializedScope && this.initializedScope.includes(userDid)) {
      this.initializedScope = null;
    }
  }

  isInitialized(): boolean {
    return this.initializedScope !== null;
  }

  async store(message: CachedMessage): Promise<void> {
    const key    = await this.keyStore.getOrCreateKey();
    const record = await this.encryptMessage(message, key);
    await this.msgStore.put(record);
    this._stored.next(message);
  }

  async storeMany(messages: CachedMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const key     = await this.keyStore.getOrCreateKey();
    const records = await Promise.all(messages.map(m => this.encryptMessage(m, key)));
    await this.msgStore.putMany(records);
  }

  async exists(messageId: string): Promise<boolean> {
    return this.msgStore.has(messageId);
  }

  // Updates senderDid and isMine on an existing cached record. senderDid/isMine
  // live only inside the encrypted blob (see EncryptedCacheRecord), so this
  // decrypts, patches, and re-encrypts rather than touching a plaintext field.
  // Called by loadHistory() to fix records cached before migration 0004.
  // Returns true if the record was found and the value actually changed.
  async updateSenderDid(messageId: string, senderDid: string, isMine: boolean): Promise<boolean> {
    const key    = await this.keyStore.getOrCreateKey();
    const record = await this.msgStore.get(messageId);
    if (!record) return false;

    const current = await this.decryptRecord(record, key);
    if (current.senderDid === senderDid && current.isMine === isMine) return false;

    const updated = await this.encryptMessage({ ...current, senderDid, isMine }, key);
    await this.msgStore.put({ ...updated, id: messageId });
    return true;
  }

  async getMessages(
    conversationId: string,
    limit: number,
    excludeDeleted: boolean,
  ): Promise<MessageCacheReadResult> {
    const key     = await this.keyStore.getOrCreateKey();
    const records = await this.msgStore.queryByConversation(conversationId, limit);
    const messages: CachedMessage[] = [];
    const ids = new Set<string>();

    for (const record of records) {
      if (excludeDeleted && record.deletedAt !== null) continue;
      try {
        const msg = await this.decryptRecord(record, key);
        messages.push(msg);
        ids.add(record.id);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'OperationError') {
          await this.msgStore.delete(record.id);
          continue;
        }
        throw err;
      }
    }

    return { messages, ids };
  }

  async getMessagesPage(
    conversationId: string,
    afterCreatedAt: number,
    limit: number,
  ): Promise<CachedMessage[]> {
    const key     = await this.keyStore.getOrCreateKey();
    const records = await this.msgStore.queryByConversationPaged(conversationId, afterCreatedAt, limit);
    const messages: CachedMessage[] = [];
    for (const record of records) {
      try {
        messages.push(await this.decryptRecord(record, key));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'OperationError') {
          await this.msgStore.delete(record.id);
          continue;
        }
        throw err;
      }
    }
    return messages;
  }

  async getById(messageId: string): Promise<CachedMessage | null> {
    const key    = await this.keyStore.getOrCreateKey();
    const record = await this.msgStore.get(messageId);
    if (!record) return null;
    return this.decryptRecord(record, key);
  }

  async getAllIds(conversationId: string): Promise<Set<string>> {
    const ids = await this.msgStore.queryAllIds(conversationId);
    return new Set(ids);
  }

  async getNewestId(conversationId: string): Promise<string | null> {
    return this.msgStore.queryNewestId(conversationId);
  }

  async softDelete(messageId: string): Promise<void> {
    await this.msgStore.updateDeletedAt(messageId, Date.now());
  }

  async hardDelete(messageId: string): Promise<void> {
    await this.msgStore.delete(messageId);
  }

  async clearAll(): Promise<void> {
    await this.msgStore.clear();
    await this.keyStore.clearKey();
  }

  async clearConversation(conversationId: string): Promise<void> {
    await this.msgStore.clearConversation(conversationId);
    localStorage.setItem(this.historyClearedKey(conversationId), String(Date.now()));
  }

  // Watermark set by clearConversation(): gap-fill must not re-decrypt server
  // messages older than this — their MLS ratchet generation is already consumed.
  getHistoryClearedAt(conversationId: string): number | null {
    const raw = localStorage.getItem(this.historyClearedKey(conversationId));
    return raw === null ? null : Number(raw);
  }

  private historyClearedKey(conversationId: string): string {
    return 'history_cleared_' + conversationId;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async encryptMessage(
    message: CachedMessage,
    key: CryptoKey,
  ): Promise<EncryptedCacheRecord> {
    const iv         = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
    const plaintext  = new TextEncoder().encode(JSON.stringify(message));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    return {
      id:                message.id,
      conversationId:    message.conversationId,
      encryptedBlob:     this.bytesToBase64(new Uint8Array(ciphertext)),
      iv:                this.bytesToBase64(iv),
      cacheVersion:      message.cacheVersion,
      encryptionVersion: message.encryptionVersion,
      undecryptable:     message.undecryptable,
      deletedAt:         message.deletedAt,
      createdAt:         message.createdAt,
      cachedAt:          message.cachedAt,
    };
  }

  private async decryptRecord(
    record: EncryptedCacheRecord,
    key: CryptoKey,
  ): Promise<CachedMessage> {
    const iv         = this.base64ToBytes(record.iv);
    const ciphertext = this.base64ToBytes(record.encryptedBlob);
    const plaintext  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as CachedMessage;
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  private base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes  = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
