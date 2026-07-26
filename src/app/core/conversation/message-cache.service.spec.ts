import { TestBed } from '@angular/core/testing';
import { MessageCacheService } from './message-cache.service';
import type { CachedMessage } from './conversation.types';

// ── spliceHistory (Phase 10 — Root Cause #3 fallback, see AUDIT_02/04/05) ────
//
// Uses the real Web IndexedDB-backed stores (this runs in an actual Chrome
// instance under Karma), not mocks, since MessageCacheService's whole
// contract is "encrypt/decrypt through IndexedDB" and that's exactly what's
// under test here. Each test uses its own unique conversation AND message ids
// (not shared constants cleared in beforeEach): the cache store's primary key
// is the message id alone (conversationId is just an indexed field), so
// reusing a literal id like 'msg-1' across tests would silently overwrite/
// relocate another test's record sharing that same key.
//
// IMPORTANT (see also the production fix this test suite caught): copying a
// message by reusing its source id and only changing conversationId would not
// create a second row -- put() upserts by id, so it would silently MOVE the
// row out of the old conversation instead of copying it. spliceHistory()
// therefore stores each copy under a fresh, deterministic synthetic id
// (`spliced:{toConversationId}:{sourceId}`), which these tests assert on
// directly rather than expecting the original ids to reappear in the destination.

describe('MessageCacheService.spliceHistory', () => {
  let service: MessageCacheService;
  const USER_DID  = 'did:plc:splice-test-user';
  const DEVICE_ID = 'device-splice-test';
  let testSeq = 0;

  function makeMessage(id: string, conversationId: string, createdAt: number): CachedMessage {
    return {
      id,
      conversationId,
      senderDeviceId:    DEVICE_ID,
      senderDid:         USER_DID,
      plaintext:         `plaintext-${id}`,
      isMine:            true,
      undecryptable:     false,
      cacheVersion:      1,
      encryptionVersion: 1,
      deletedAt:         null,
      createdAt,
      cachedAt:          createdAt,
    };
  }

  function uniqueIds(): { oldConv: string; newConv: string; msgId: (n: number) => string } {
    testSeq += 1;
    const seq = testSeq;
    return {
      oldConv: `conv-old-${seq}-${Date.now()}`,
      newConv: `conv-new-${seq}-${Date.now()}`,
      msgId:   (n: number) => `msg-${seq}-${n}-${Date.now()}`,
    };
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [MessageCacheService] });
    service = TestBed.inject(MessageCacheService);
    await service.initialize(USER_DID, DEVICE_ID);
  });

  it('copies all cached messages from the old conversation into the new one, preserving plaintext', async () => {
    const { oldConv, newConv, msgId } = uniqueIds();
    const [id1, id2, id3] = [msgId(1), msgId(2), msgId(3)];
    await service.storeMany([
      makeMessage(id1, oldConv, 1000),
      makeMessage(id2, oldConv, 2000),
      makeMessage(id3, oldConv, 3000),
    ]);

    const copied = await service.spliceHistory(oldConv, newConv);
    expect(copied).toBe(3);

    const result = await service.getMessages(newConv, 50, true);
    expect(result.messages.length).toBe(3);
    expect(result.messages.every(m => m.conversationId === newConv)).toBe(true);
    expect(result.messages.map(m => m.plaintext).sort()).toEqual(
      [id1, id2, id3].map(id => `plaintext-${id}`).sort(),
    );

    // Original conversation's cache is untouched -- splice only ever ADDS to
    // the destination, it never removes from (or mutates) the source.
    const oldResult = await service.getMessages(oldConv, 50, true);
    expect(oldResult.messages.length).toBe(3);
    expect(oldResult.messages.map(m => m.id).sort()).toEqual([id1, id2, id3].sort());
  });

  it('is safe to call twice: does not duplicate messages already spliced into the destination', async () => {
    const { oldConv, newConv, msgId } = uniqueIds();
    await service.storeMany([makeMessage(msgId(1), oldConv, 1000)]);

    await service.spliceHistory(oldConv, newConv);
    const secondCopied = await service.spliceHistory(oldConv, newConv);

    expect(secondCopied).toBe(0); // nothing new to copy the second time

    const result = await service.getMessages(newConv, 50, true);
    expect(result.messages.length).toBe(1);
  });

  it('does not affect a message natively already stored in the new conversation', async () => {
    const { oldConv, newConv, msgId } = uniqueIds();
    const nativeId = msgId(1);
    const historyId = msgId(2);

    // A message genuinely sent/received in the new conversation itself (its
    // own real id, unrelated to anything in the old conversation).
    await service.store(makeMessage(nativeId, newConv, 500));
    await service.storeMany([makeMessage(historyId, oldConv, 1000)]);

    const copied = await service.spliceHistory(oldConv, newConv);
    expect(copied).toBe(1);

    const result = await service.getMessages(newConv, 50, true);
    expect(result.messages.length).toBe(2); // native message + 1 spliced, no collision
    const native = result.messages.find(m => m.id === nativeId);
    expect(native?.plaintext).toBe(`plaintext-${nativeId}`); // untouched
  });

  it('returns 0 when the old conversation has no cached messages', async () => {
    const { oldConv, newConv } = uniqueIds();
    const copied = await service.spliceHistory(oldConv, newConv);
    expect(copied).toBe(0);
  });
});
