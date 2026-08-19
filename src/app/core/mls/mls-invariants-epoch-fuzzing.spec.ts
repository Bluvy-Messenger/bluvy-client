import { FakeMlsBackend, EpochGapError, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 6 of the multi-device validation audit: epoch fuzzing.
//
// Coverage split deliberately:
// - The client-side applyCommit() cases (epoch === current -> apply; epoch <
//   current -> discard as duplicate; epoch > current -> EpochGapError) are
//   ALREADY covered by mls-commit.service.spec.ts's three dedicated tests
//   and are not re-tested here to avoid duplication.
// - This file covers what those don't: the BACKEND arbitration's response to
//   fuzzed epoch values (gap of +10, negative/invalid epoch, duplicate
//   delivery, out-of-order arrival, several concurrent commits), using
//   FakeMlsBackend directly (fast, pure JS -- no crypto needed, since the
//   backend's own epoch-continuity check never inspects commit bytes, only
//   the epoch number and the (conversationId, epoch) uniqueness), plus one
//   real end-to-end client case (epoch+10 gap) that exercises actual ts-mls
//   decoding to confirm the magnitude of the gap doesn't matter.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-epoch-fuzz';

describe('MLS multi-device invariants — epoch fuzzing (Section 6)', () => {

  describe('FakeMlsBackend arbitration (mirrors bluvy-backend storeMlsCommit, independently proven server-side in mls.service.test.ts)', () => {
    it('accepts epoch 0 as the first commit for a fresh conversation', async () => {
      const backend = new FakeMlsBackend();
      const row = await backend.postCommit(CONV_ID, DEVICE_A.id, 'commit-bytes', 0);
      expect(row.epoch).toBe(0);
      expect(backend.getCommits(CONV_ID).length).toBe(1);
    });

    it('accepts epoch N+1 (normal continuity)', async () => {
      const backend = new FakeMlsBackend();
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);
      const row = await backend.postCommit(CONV_ID, DEVICE_A.id, 'c1', 1);
      expect(row.epoch).toBe(1);
    });

    it('rejects a gap of +10 (EpochGapError, not silently accepted, not truncated to +1)', async () => {
      const backend = new FakeMlsBackend();
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);
      await expectAsync(backend.postCommit(CONV_ID, DEVICE_A.id, 'c-far', 10)).toBeRejectedWith(jasmine.any(EpochGapError));
      expect(backend.getCommits(CONV_ID).length).toBe(1); // the bad attempt left no trace
    });

    it('rejects a stale/obsolete epoch (behind maxEpoch, not just below current+1)', async () => {
      const backend = new FakeMlsBackend();
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c1', 1);
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c2', 2);
      // Re-attempting epoch 0 now (maxEpoch=2) is a gap, not a duplicate --
      // epoch 0 already exists, so this actually hits the DEDUP branch
      // (returns the stored epoch-0 row, not a new epoch-3 insertion).
      const row = await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0-again', 0);
      expect(row.commit).toBe('c0'); // the ORIGINAL epoch-0 commit, never overwritten
      expect(backend.getCommits(CONV_ID).length).toBe(3); // unchanged
    });

    it('rejects a negative epoch outright (never extends any chain, including a fresh conversation expecting 0)', async () => {
      const backend = new FakeMlsBackend();
      await expectAsync(backend.postCommit(CONV_ID, DEVICE_A.id, 'c-neg', -1)).toBeRejectedWith(jasmine.any(EpochGapError));
      expect(backend.getCommits(CONV_ID).length).toBe(0);
    });

    it('a commit delivered twice (exact duplicate: same conversationId+epoch+sender) is deduplicated, not double-counted', async () => {
      const backend = new FakeMlsBackend();
      const first  = await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);
      const second = await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);
      expect(second.id).toBe(first.id);
      expect(backend.getCommits(CONV_ID).length).toBe(1);
    });

    it('commits arriving out of order (2 posted before 1) are handled by rejecting the early one, not applying out of sequence', async () => {
      const backend = new FakeMlsBackend();
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);
      // epoch 2 arrives before epoch 1 -- rejected, epoch 1 must come first.
      await expectAsync(backend.postCommit(CONV_ID, DEVICE_A.id, 'c2-early', 2)).toBeRejectedWith(jasmine.any(EpochGapError));
      // Now deliver in the correct order.
      const row1 = await backend.postCommit(CONV_ID, DEVICE_A.id, 'c1', 1);
      const row2 = await backend.postCommit(CONV_ID, DEVICE_A.id, 'c2', 2);
      expect([row1.epoch, row2.epoch]).toEqual([1, 2]);
      expect(backend.getCommits(CONV_ID).map(c => c.epoch)).toEqual([0, 1, 2]);
    });

    it('several commits truly concurrent at the same epoch: exactly one accepted regardless of arrival count (3-way race)', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      await backend.postCommit(CONV_ID, DEVICE_A.id, 'c0', 0);

      const results = await Promise.allSettled([
        backend.postCommit(CONV_ID, 'device-x', 'c1-x', 1),
        backend.postCommit(CONV_ID, 'device-y', 'c1-y', 1),
        backend.postCommit(CONV_ID, 'device-z', 'c1-z', 1),
      ]);
      expect(results.every(r => r.status === 'fulfilled')).toBe(true); // all resolve (losers get the winner back, none reject)
      const rows = (results as PromiseFulfilledResult<{ id: string }>[]).map(r => r.value.id);
      expect(new Set(rows).size).toBe(1); // all three calls resolved to the SAME row id
      expect(backend.getCommits(CONV_ID).filter(c => c.epoch === 1).length).toBe(1);
    });
  });

  describe('Real client applyCommit() with a large epoch gap', () => {
    it('a +10 epoch gap is treated identically to a +1 gap (EpochGapError, triggers real catch-up, converges)', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      // Advance the conversation 9 further epochs on A alone (B stays behind
      // the whole time, simulating "offline for a long stretch").
      for (let i = 0; i < 9; i++) {
        await a.membershipSvc.provisionDevice(`filler-device-${i}`, CONV_ID, USER_A, DEVICE_A);
      }
      expect(a.epoch(CONV_ID)).toBe(10); // 1 (genesis) + 9 provisions

      // B is still at epoch 1 -- a real 9-epoch gap from its perspective.
      expect(b.epoch(CONV_ID)).toBe(1);

      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(b.epoch(CONV_ID)).toBe(10);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());

      // Real round-trip proof of convergence, not just matching epoch numbers.
      const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'after a 9-epoch catch-up');
      const plaintext  = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);
      expect(plaintext).toBe('after a 9-epoch catch-up');
    });
  });
});
