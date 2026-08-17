import { TestBed } from '@angular/core/testing';
import { PendingDecryptRepository, type PendingDecryptEntry } from './pending-decrypt.repository';

// Regression test: enqueue() used to always write attempts:0/enqueuedAt:Date.now()
// on every call, even when re-enqueuing a messageId that already had a record.
// mls-coordinator.service.ts's decryptMessage() re-enqueues the same messageId
// on every retry attempt (conversation reopen, incoming message.new retry) with
// a fresh attempts:0 payload -- this silently reset the retry budget
// replayPendingDecrypts() relies on (attempts >= 1 => permanent/undecryptable),
// so a message stuck behind a transient error looped as pending_decrypt forever
// instead of ever reaching the undecryptable fallback.
describe('PendingDecryptRepository — retry bookkeeping across re-enqueue', () => {
  let repo: PendingDecryptRepository;
  const DID       = 'did:plc:alice';
  const DEVICE_ID = 'device-1';

  function makeEntry(overrides: Partial<PendingDecryptEntry> = {}): PendingDecryptEntry {
    return {
      messageId:      'msg-1',
      conversationId: 'conv-1',
      ciphertext:     'cGxhaW50ZXh0',
      senderDid:      'did:plc:xavier',
      senderDeviceId: 'device-2',
      isMine:         false,
      createdAt:      Date.now(),
      enqueuedAt:     Date.now(),
      attempts:       0,
      lastAttemptAt:  null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [PendingDecryptRepository] });
    repo = TestBed.inject(PendingDecryptRepository);
    await repo.initialize(DID, DEVICE_ID);
    await repo.clearAll();
  });

  afterEach(async () => {
    await repo.clearAll();
    await repo.clearAllForUser(DID, DEVICE_ID);
  });

  it('preserves attempts/enqueuedAt/lastAttemptAt when re-enqueuing an existing messageId', async () => {
    const originalEnqueuedAt = Date.now() - 10_000;
    await repo.enqueue(makeEntry({ enqueuedAt: originalEnqueuedAt }));
    await repo.markAttempt('msg-1');

    const [afterAttempt] = await repo.getAll('conv-1');
    expect(afterAttempt?.attempts).toBe(1);
    const lastAttemptAt = afterAttempt?.lastAttemptAt;
    expect(lastAttemptAt).not.toBeNull();

    // Simulate decryptMessage() re-enqueuing the same message on a later retry
    // with a fresh attempts:0 payload, as it does today.
    await repo.enqueue(makeEntry({ enqueuedAt: Date.now(), attempts: 0, lastAttemptAt: null }));

    const [afterReenqueue] = await repo.getAll('conv-1');
    expect(afterReenqueue?.attempts).toBe(1);
    expect(afterReenqueue?.enqueuedAt).toBe(originalEnqueuedAt);
    expect(afterReenqueue?.lastAttemptAt).toBe(lastAttemptAt!);
  });

  it('still defaults a brand-new messageId to the attempts it was enqueued with', async () => {
    await repo.enqueue(makeEntry({ messageId: 'msg-2', attempts: 0 }));

    const [entry] = await repo.getAll('conv-1');
    expect(entry?.messageId).toBe('msg-2');
    expect(entry?.attempts).toBe(0);
  });
});
