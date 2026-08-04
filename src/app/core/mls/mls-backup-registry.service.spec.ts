import { TestBed } from '@angular/core/testing';
import { MlsBackupRegistry, type MlsBackupServiceRef } from './mls-backup-registry.service';

describe('MlsBackupRegistry', () => {
  let registry: MlsBackupRegistry;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MlsBackupRegistry] });
    registry = TestBed.inject(MlsBackupRegistry);
  });

  it('starts with no backup service registered', () => {
    expect(registry.backupService).toBeNull();
  });

  it('exposes the registered service after setBackupService', () => {
    const ref: MlsBackupServiceRef = {
      backupGroupState: () => {},
      enqueue: () => {},
      isMbkAvailable: () => true,
      restore: () => Promise.resolve(),
    };

    registry.setBackupService(ref);

    expect(registry.backupService).toBe(ref);
  });

  it('replaces a previously registered service on a second call', () => {
    const first: MlsBackupServiceRef = {
      backupGroupState: () => {}, enqueue: () => {}, isMbkAvailable: () => true, restore: () => Promise.resolve(),
    };
    const second: MlsBackupServiceRef = {
      backupGroupState: () => {}, enqueue: () => {}, isMbkAvailable: () => false, restore: () => Promise.resolve(),
    };

    registry.setBackupService(first);
    registry.setBackupService(second);

    expect(registry.backupService).toBe(second);
  });
});
