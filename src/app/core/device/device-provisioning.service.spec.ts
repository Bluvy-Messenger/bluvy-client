import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { DeviceProvisioningService } from './device-provisioning.service';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { ConversationsService } from '../conversation/conversations.service';
import { SyncService } from '../sync/sync.service';
import { DeviceRepository } from './device.repository';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from './device.types';
import type { ConversationsPage } from '../conversation/conversation.types';

// ── Proactive Recovery Sweep (Phase 6, see MLS_FINAL_IMPLEMENTATION_PLAN.md /
// AUDIT_05_HISTORICAL_RECOVERY.md Category B) ─────────────────────────────

describe('DeviceProvisioningService.proactiveCatchUpSweep', () => {
  let service: DeviceProvisioningService;
  let mockCoordinator: jasmine.SpyObj<MlsCoordinatorBase>;
  let mockConvSvc: jasmine.SpyObj<ConversationsService>;

  const USER:   UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const DEVICE: DeviceInfo  = { id: 'device-a1', name: 'Phone', platform: 'android' };

  function page(data: Array<{ id: string }>, hasMore: boolean, cursor: string | null): ConversationsPage {
    return { data: data as ConversationsPage['data'], hasMore, cursor };
  }

  beforeEach(() => {
    mockCoordinator = jasmine.createSpyObj<MlsCoordinatorBase>('MlsCoordinatorBase', ['catchUpMissedCommits']);
    mockConvSvc     = jasmine.createSpyObj<ConversationsService>('ConversationsService', ['getConversations']);

    TestBed.configureTestingModule({
      providers: [
        DeviceProvisioningService,
        { provide: MlsCoordinatorBase, useValue: mockCoordinator },
        { provide: ConversationsService, useValue: mockConvSvc },
        { provide: SyncService, useValue: jasmine.createSpyObj<SyncService>('SyncService', ['flush']) },
        { provide: DeviceRepository, useValue: jasmine.createSpyObj<DeviceRepository>('DeviceRepository', ['getMyDevices']) },
      ],
    });
    service = TestBed.inject(DeviceProvisioningService);
  });

  it('calls catchUpMissedCommits for every non-archived conversation across pages', async () => {
    mockConvSvc.getConversations.and.callFake((cursor?: string, _limit?: number, archived?: boolean) => {
      if (archived) return of(page([], false, null));
      if (!cursor)  return of(page([{ id: 'conv-1' }, { id: 'conv-2' }], true, 'cursor-1'));
      return of(page([{ id: 'conv-3' }], false, null));
    });
    mockCoordinator.catchUpMissedCommits.and.returnValue(Promise.resolve());

    await service.proactiveCatchUpSweep(USER, DEVICE);

    expect(mockCoordinator.catchUpMissedCommits).toHaveBeenCalledWith('conv-1', USER, DEVICE);
    expect(mockCoordinator.catchUpMissedCommits).toHaveBeenCalledWith('conv-2', USER, DEVICE);
    expect(mockCoordinator.catchUpMissedCommits).toHaveBeenCalledWith('conv-3', USER, DEVICE);
    expect(mockCoordinator.catchUpMissedCommits).toHaveBeenCalledTimes(3);
  });

  it('also sweeps archived conversations', async () => {
    mockConvSvc.getConversations.and.callFake((_cursor?: string, _limit?: number, archived?: boolean) =>
      archived ? of(page([{ id: 'conv-archived' }], false, null)) : of(page([], false, null)));
    mockCoordinator.catchUpMissedCommits.and.returnValue(Promise.resolve());

    await service.proactiveCatchUpSweep(USER, DEVICE);

    expect(mockCoordinator.catchUpMissedCommits).toHaveBeenCalledWith('conv-archived', USER, DEVICE);
  });

  it('continues sweeping remaining conversations even if one fails', async () => {
    mockConvSvc.getConversations.and.callFake((_cursor?: string, _limit?: number, archived?: boolean) =>
      archived ? of(page([], false, null)) : of(page([{ id: 'conv-bad' }, { id: 'conv-ok' }], false, null)));
    mockCoordinator.catchUpMissedCommits.and.callFake((convId: string) =>
      convId === 'conv-bad' ? Promise.reject(new Error('boom')) : Promise.resolve());

    await service.proactiveCatchUpSweep(USER, DEVICE);

    expect(mockCoordinator.catchUpMissedCommits).toHaveBeenCalledWith('conv-ok', USER, DEVICE);
  });

  it('does not throw if the conversations list fails to load', async () => {
    mockConvSvc.getConversations.and.returnValue(throwError(() => new Error('network down')));

    await expectAsync(service.proactiveCatchUpSweep(USER, DEVICE)).toBeResolved();
    expect(mockCoordinator.catchUpMissedCommits).not.toHaveBeenCalled();
  });

  it('runs at most once per user DID per service instance', async () => {
    mockConvSvc.getConversations.and.callFake((_cursor?: string, _limit?: number, archived?: boolean) =>
      archived ? of(page([], false, null)) : of(page([{ id: 'conv-1' }], false, null)));
    mockCoordinator.catchUpMissedCommits.and.returnValue(Promise.resolve());

    await service.proactiveCatchUpSweep(USER, DEVICE);
    await service.proactiveCatchUpSweep(USER, DEVICE);

    expect(mockConvSvc.getConversations).toHaveBeenCalledTimes(2); // one call for archived=false + one for archived=true, first run only
  });
});
