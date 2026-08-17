import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 9 of the multi-device validation audit: hand-rolled property-based
// testing. No fast-check (or any property-testing library) is installed,
// and this audit is restricted to test files only -- adding a new
// devDependency to package.json is a production-config change, out of
// scope. A seeded PRNG stands in for it: deterministic given a numeric
// seed, so a failure is exactly reproducible by re-running with the same
// seed (printed on failure below), and the full operation sequence up to
// the failing step is printed verbatim -- this is exact reproduction, not
// automatic delta-debugging/shrinking (no library for that either); the
// printed sequence IS the minimal repro in the sense that it is exactly
// what happened, just not minimized to the fewest possible steps.
//
// Operation vocabulary, deliberately scoped to what the harness can
// genuinely fuzz with real ts-mls crypto (no MlsWelcomeService/SyncService
// wiring here -- see mls-multidevice-harness.ts): Add, Remove, CatchUp
// (also stands in for Reconnect -- same client action), Duplicate (redeliver
// the last commit B already applied). "Welcome" and "Restore" as literal
// fuzzed operation types are NOT included here — Welcome's state-machine
// safety is property-tested at the coordinator level in
// mls-coordinator.restore-race.spec.ts (which DOES use a seeded/controlled
// interleaving, just not a randomized op sequence), and Restore's
// interaction with an in-flight Welcome is exhaustively covered there too.

type Op = 'add' | 'remove' | 'catchup' | 'duplicate';
const OPS: Op[] = ['add', 'remove', 'catchup', 'duplicate'];

// mulberry32 -- small, deterministic, seeded PRNG (public domain algorithm).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-property';

async function runSequence(seed: number, steps: number): Promise<void> {
  const rand = mulberry32(seed);
  const backend = new FakeMlsBackend();
  const a = new Device(backend, USER_A, DEVICE_A);
  const b = new Device(backend, USER_B, DEVICE_B);
  await makeGroup(CONV_ID, backend, a, [b]);

  const log: Op[] = [];
  const addedDevices: string[] = [];
  let lastAppliedCommit: { commit: string; epoch: number } | null = null;
  let epochHistory: number[] = [a.epoch(CONV_ID)];

  const invariantViolation = (message: string) => {
    throw new Error(
      `Property violated with seed=${seed}: ${message}\n` +
      `Sequence so far (${log.length} steps): ${JSON.stringify(log)}\n` +
      `To reproduce exactly: re-run runSequence(${seed}, ${steps}).`,
    );
  };

  for (let i = 0; i < steps; i++) {
    const op = OPS[Math.floor(rand() * OPS.length)]!;
    log.push(op);

    try {
      switch (op) {
        case 'add': {
          const newId = `prop-device-${seed}-${i}`;
          await a.membershipSvc.provisionDevice(newId, CONV_ID, USER_A, DEVICE_A);
          addedDevices.push(newId);
          break;
        }
        case 'remove': {
          if (addedDevices.length === 0) break; // nothing to remove yet -- valid no-op step
          const target = addedDevices[Math.floor(rand() * addedDevices.length)]!;
          console.log(`[repro] step ${i} remove target=${target} membersBefore=${JSON.stringify(a.memberDeviceIds(CONV_ID))} epochBefore=${a.epoch(CONV_ID)}`);
          await a.membershipSvc.removeRevokedDeviceFromAllGroups(target, USER_A, DEVICE_A);
          console.log(`[repro] step ${i} remove target=${target} membersAfter=${JSON.stringify(a.memberDeviceIds(CONV_ID))} epochAfter=${a.epoch(CONV_ID)}`);
          break;
        }
        case 'catchup': {
          const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
          if (applied > 0) {
            const commits = backend.getCommits(CONV_ID);
            lastAppliedCommit = { commit: commits[commits.length - 1]!.commit, epoch: commits[commits.length - 1]!.epoch };
          }
          break;
        }
        case 'duplicate': {
          if (!lastAppliedCommit) break; // nothing applied yet -- valid no-op step
          await b.commitSvc.processIncomingCommit(CONV_ID, lastAppliedCommit.commit, lastAppliedCommit.epoch, USER_B, DEVICE_B);
          break;
        }
      }
    } catch (err) {
      invariantViolation(`operation '${op}' at step ${i} threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Invariant, checked after EVERY step: A's epoch never regresses.
    const currentEpoch = a.epoch(CONV_ID);
    if (currentEpoch < epochHistory[epochHistory.length - 1]!) {
      invariantViolation(`A's epoch regressed from ${epochHistory[epochHistory.length - 1]} to ${currentEpoch} after step ${i} ('${op}')`);
    }
    epochHistory.push(currentEpoch);

    // Invariant, checked after every 'catchup' step specifically: B is
    // never AHEAD of A (B only ever applies what A/the backend already has).
    if (op === 'catchup' && b.epoch(CONV_ID) > a.epoch(CONV_ID)) {
      invariantViolation(`B's epoch (${b.epoch(CONV_ID)}) exceeded A's (${a.epoch(CONV_ID)}) after a catchup step`);
    }
  }

  // Final invariant: full convergence once B is given one last chance to
  // catch up completely (a random sequence may end mid-gap by construction).
  await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
  if (b.epoch(CONV_ID) !== a.epoch(CONV_ID)) {
    invariantViolation(`final epoch mismatch after full catch-up: A=${a.epoch(CONV_ID)} B=${b.epoch(CONV_ID)}`);
  }
  const membersA = a.memberDeviceIds(CONV_ID).sort();
  const membersB = b.memberDeviceIds(CONV_ID).sort();
  if (JSON.stringify(membersA) !== JSON.stringify(membersB)) {
    invariantViolation(`final membership mismatch: A=${JSON.stringify(membersA)} B=${JSON.stringify(membersB)}`);
  }

  // Strongest final check: real round-trip decryption both ways.
  const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, `end-of-sequence seed=${seed}`);
  const seenByB = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA);
  if (seenByB !== `end-of-sequence seed=${seed}`) {
    invariantViolation(`final decrypt mismatch: got "${seenByB}"`);
  }
}

// FIXED: seed=17 previously found a confirmed production bug in
// mls-membership.service.ts's removeRevokedDeviceFromAllGroups() (see the
// "double removal" describe block below for the full root cause and fix).
// All seeds, including 17, are expected to pass now.
describe('MLS multi-device invariants — property-based random operation sequences (Section 9)', () => {
  const NUM_SEQUENCES = 20;
  const STEPS_PER_SEQUENCE = 12;

  for (let seed = 1; seed <= NUM_SEQUENCES; seed++) {
    it(`random sequence seed=${seed} (${STEPS_PER_SEQUENCE} steps of Add/Remove/CatchUp/Duplicate) preserves all invariants`, async () => {
      await runSequence(seed, STEPS_PER_SEQUENCE);
    });
  }
});

// Minimal, deterministic, hand-reduced reproduction of the seed=17 finding
// above -- no randomness, no catchup/duplicate noise, isolates the exact
// trigger: removing a SECOND, different, still-present member after the
// conversation's tree already contains one blanked leaf from a prior removal.
//
// FIXED (was a documented, confirmed-not-fixed finding at the time this test
// was written): removeRevokedDeviceFromAllGroups() (mls-membership.service.ts)
// used to locate the leaf to remove via `members.findIndex(...)` on the
// COMPACTED array returned by getGroupMembers() (ts-mls/clientState.js),
// which filters out blank leaves -- so its array position stops matching the
// real MLS leaf index as soon as any earlier leaf has been blanked by a
// prior Remove. It now uses ts-mls's own findLeafIndex() (ts-mls/ratchetTree.js),
// which resolves the true leaf index directly from the raw ratchetTree by
// matching the LeafNode itself, independent of any earlier blanks. This test
// now asserts the fixed (correct) behavior: the second removal succeeds.
describe('MLS multi-device invariants — double removal after a prior Remove already blanked a leaf (Section 9, reduced from seed=17)', () => {
  const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
  const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
  const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
  const CONV_ID = 'conv-minimal-repro';

  it('add 3 devices, remove the 2nd, then remove the 3rd (still present): the second removal succeeds', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-z', CONV_ID, USER_A, DEVICE_A);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(
      [DEVICE_A.id, DEVICE_B.id, 'device-x', 'device-y', 'device-z'].sort(),
    );

    // First removal: succeeds, blanks one leaf.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-y', USER_A, DEVICE_A);
    expect(a.memberDeviceIds(CONV_ID)).not.toContain('device-y');
    expect(a.memberDeviceIds(CONV_ID)).withContext('device-z must still be a legitimate, present member here').toContain('device-z');

    // Second removal, of a DIFFERENT, still-present device -- must succeed
    // exactly like the first removal did, not throw.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-z', USER_A, DEVICE_A);
    expect(a.memberDeviceIds(CONV_ID)).not.toContain('device-z');
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id, 'device-x'].sort());
  });
});
