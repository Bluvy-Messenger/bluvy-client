import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { DeviceIdentityRepository } from './device-identity.repository';

// Regression test for forensic audit finding F2: the backend can return a
// different deviceId than the one requested (e.g. a revoked local id fails
// the idempotent-reuse filter in devices.service.ts's upsertActiveDevice, so
// a fresh uuidv7() is minted server-side). Before persist() existed, the
// client never learned this happened -- the stale local id kept being resent
// on every subsequent login, minting a new phantom device row each time and
// orphaning this device's MLS state (new scope = mls:<did>:<newId>) on every
// login. persist() closes that loop.
describe('DeviceIdentityRepository — server reconciliation (F2)', () => {
  let repo: DeviceIdentityRepository;
  const DID = 'did:plc:alice';

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [DeviceIdentityRepository] });
    repo = TestBed.inject(DeviceIdentityRepository);
    await Preferences.clear();
  });

  afterEach(async () => {
    await Preferences.clear();
  });

  it('persists a server-assigned deviceId that differs from the locally requested one', async () => {
    const original = await repo.getOrCreate(DID);

    await repo.persist(DID, 'server-assigned-id');

    const reconciled = await repo.get(DID);
    expect(reconciled?.id).toBe('server-assigned-id');
    expect(reconciled?.id).not.toBe(original.id);
  });

  it('a subsequent getOrCreate() after persist() returns the reconciled id, not a fresh one', async () => {
    await repo.getOrCreate(DID);
    await repo.persist(DID, 'server-assigned-id');

    const afterReconcile = await repo.getOrCreate(DID);

    expect(afterReconcile.id).toBe('server-assigned-id');
  });

  it('get() returns null when no identity has ever been created for this DID', async () => {
    const result = await repo.get('did:plc:never-seen');
    expect(result).toBeNull();
  });
});
