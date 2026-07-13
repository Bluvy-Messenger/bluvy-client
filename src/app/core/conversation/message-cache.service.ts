import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import type { IKeyStore, IMessageStore, EncryptedCacheRecord } from './cache/message-cache.types';
import { WebKeyStore }        from './cache/web-key-store';
import { WebMessageStore }    from './cache/web-message-store';
import { NativeKeyStore }     from './cache/native-key-store';
import { NativeMessageStore } from './cache/native-message-store';

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


  async initialize(userDid: string, deviceId: string): Promise<void> {
    const scope = `cache:${userDid}:${deviceId}`;
    if (this.initializedScope === scope) return;

    if (Capacitor.isNativePlatform()) {
      this.keyStore = new NativeKeyStore(); // Android Keystore / iOS Keychain
      this.msgStore = new NativeMessageStore();
    } else {
      this.keyStore = new WebKeyStore();    // WebCrypto + IndexedDB
      this.msgStore = new WebMessageStore();
    }

    // Sequential: WebMessageStore.initialize() creates the IDB schema first
    // so WebKeyStore.initialize() finds the DB already set up.
    await this.msgStore.initialize();
    await this.keyStore.initialize(scope);
    this.initializedScope = scope;
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

  // Updates senderDid and isMine on an existing cached record without re-encrypting the blob.
  // Called by loadHistory() to fix records cached before migration 0004.
  // Returns true if the record was found and the value actually changed.
  async updateSenderDid(messageId: string, senderDid: string, isMine: boolean): Promise<boolean> {
    return this.msgStore.updateSenderDid(messageId, senderDid, isMine);
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
      senderDeviceId:    message.senderDeviceId,
      senderDid:         message.senderDid,
      encryptedBlob:     this.bytesToBase64(new Uint8Array(ciphertext)),
      iv:                this.bytesToBase64(iv),
      cacheVersion:      message.cacheVersion,
      encryptionVersion: message.encryptionVersion,
      isMine:            message.isMine,
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
    const msg        = JSON.parse(new TextDecoder().decode(plaintext)) as CachedMessage;

    // Plain fields may have been updated by updateSenderDid() after the blob was written.
    // The plain field always takes precedence for isMine and senderDid.
    return {
      ...msg,
      isMine:    record.isMine,
      senderDid: record.senderDid ?? msg.senderDid,
    };
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
