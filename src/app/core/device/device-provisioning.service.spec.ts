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

// ── Provisioning holes fix (forensic audit finding F4) ────────────────────
// handleDeviceNew() and checkAndProvisionOnConnect() used to call
// getConversations(undefined, 100) once each -- a single page, non-archived
// only -- so any account with >100 conversations, or any archived
// conversation, permanently excluded a new device from the remainder with no
// retry or signal. Both now share proactiveCatchUpSweep's pagination +
// archived-sweep helper (forEachConversation).

describe('DeviceProvisioningService.handleDeviceNew — pagination + archived sweep (F4)', () => {
  let service: DeviceProvisioningService;
  let mockCoordinator: jasmine.SpyObj<MlsCoordinatorBase>;
  let mockConvSvc: jasmine.SpyObj<ConversationsService>;

  const USER:   UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const DEVICE: DeviceInfo  = { id: 'device-a1', name: 'Phone', platform: 'android' };

  function page(data: Array<{ id: string }>, hasMore: boolean, cursor: string | null): ConversationsPage {
    return { data: data as ConversationsPage['data'], hasMore, cursor };
  }

  beforeEach(() => {
    mockCoordinator = jasmine.createSpyObj<MlsCoordinatorBase>('MlsCoordinatorBase', ['canProvision', 'provisionDevice', 'reprovisionLostStateDevice']);
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
    mockCoordinator.canProvision.and.returnValue(Promise.resolve(true));
    mockCoordinator.provisionDevice.and.returnValue(Promise.resolve());
  });

  it('provisions a new device into a conversation beyond the first page', async () => {
    mockConvSvc.getConversations.and.callFake((cursor?: string, _limit?: number, archived?: boolean) => {
      if (archived) return of(page([], false, null));
      if (!cursor)  return of(page([{ id: 'conv-1' }], true, 'cursor-1'));
      return of(page([{ id: 'conv-101' }], false, null));
    });

    await service.handleDeviceNew('device-new', USER, DEVICE);

    expect(mockCoordinator.provisionDevice).toHaveBeenCalledWith('device-new', 'conv-1', USER, DEVICE);
    expect(mockCoordinator.provisionDevice).toHaveBeenCalledWith('device-new', 'conv-101', USER, DEVICE);
  });

  it('provisions a new device into an archived conversation', async () => {
    mockConvSvc.getConversations.and.callFake((_cursor?: string, _limit?: number, archived?: boolean) =>
      archived ? of(page([{ id: 'conv-archived' }], false, null)) : of(page([], false, null)));

    await service.handleDeviceNew('device-new', USER, DEVICE);

    expect(mockCoordinator.provisionDevice).toHaveBeenCalledWith('device-new', 'conv-archived', USER, DEVICE);
  });
});

// checkAndProvisionOnConnect's own-device provisioning now reads a precise,
// server-computed list (GET /v1/devices/pending-provisions) instead of
// blindly looping every own device x every conversation. See
// devices.service.test.ts's getPendingProvisions suite for the server-side
// query coverage; these tests cover the client's consumption of that list.
describe('DeviceProvisioningService.checkAndProvisionOnConnect — pending-provisions list', () => {
  let service: DeviceProvisioningService;
  let mockCoordinator: jasmine.SpyObj<MlsCoordinatorBase>;
  let mockConvSvc: jasmine.SpyObj<ConversationsService>;
  let mockDeviceRepo: jasmine.SpyObj<DeviceRepository>;

  const USER:   UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const DEVICE: DeviceInfo  = { id: 'device-a1', name: 'Phone', platform: 'android' };

  beforeEach(() => {
    mockCoordinator = jasmine.createSpyObj<MlsCoordinatorBase>('MlsCoordinatorBase', ['canProvision', 'provisionDevice', 'removeRevokedDeviceFromAllGroups']);
    mockConvSvc     = jasmine.createSpyObj<ConversationsService>('ConversationsService', ['getConversations']);
    mockDeviceRepo  = jasmine.createSpyObj<DeviceRepository>('DeviceRepository', ['getPendingProvisions', 'getRevokedDevices']);

    TestBed.configureTestingModule({
      providers: [
        DeviceProvisioningService,
        { provide: MlsCoordinatorBase, useValue: mockCoordinator },
        { provide: ConversationsService, useValue: mockConvSvc },
        { provide: SyncService, useValue: jasmine.createSpyObj<SyncService>('SyncService', ['flush']) },
        { provide: DeviceRepository, useValue: mockDeviceRepo },
      ],
    });
    service = TestBed.inject(DeviceProvisioningService);
    mockCoordinator.canProvision.and.returnValue(Promise.resolve(true));
    mockCoordinator.provisionDevice.and.returnValue(Promise.resolve());
    mockCoordinator.removeRevokedDeviceFromAllGroups.and.returnValue(Promise.resolve());
    mockDeviceRepo.getRevokedDevices.and.returnValue(Promise.resolve({ data: [] }));
  });

  it('provisions every pair returned by the pending-provisions endpoint', async () => {
    mockDeviceRepo.getPendingProvisions.and.returnValue(Promise.resolve({
      data: [
        { deviceId: 'device-a2', conversationId: 'conv-1' },
        { deviceId: 'device-a2', conversationId: 'conv-archived' },
      ],
    }));

    await service.checkAndProvisionOnConnect(USER, DEVICE);

    expect(mockCoordinator.provisionDevice).toHaveBeenCalledWith('device-a2', 'conv-1', USER, DEVICE);
    expect(mockCoordinator.provisionDevice).toHaveBeenCalledWith('device-a2', 'conv-archived', USER, DEVICE);
    expect(mockConvSvc.getConversations).not.toHaveBeenCalled();
  });

  it('skips a pair whose conversation the caller cannot currently provision into', async () => {
    mockDeviceRepo.getPendingProvisions.and.returnValue(Promise.resolve({
      data: [{ deviceId: 'device-a2', conversationId: 'conv-not-ready' }],
    }));
    mockCoordinator.canProvision.and.returnValue(Promise.resolve(false));

    await service.checkAndProvisionOnConnect(USER, DEVICE);

    expect(mockCoordinator.provisionDevice).not.toHaveBeenCalled();
  });

  it('continues with remaining pairs if one provisionDevice call fails', async () => {
    mockDeviceRepo.getPendingProvisions.and.returnValue(Promise.resolve({
      data: [
        { deviceId: 'device-bad', conversationId: 'conv-1' },
        { deviceId: 'device-ok',  conversationId: 'conv-2' },
      ],
    }));
    mockCoordinator.provisionDevice.and.callFake((deviceId: string) =>
      deviceId === 'device-bad' ? Promise.reject(new Error('boom')) : Promise.resolve());

    await service.checkAndProvisionOnConnect(USER, DEVICE);

    expect(mockCoordinator.provisionDevice).toHaveBeenCalledWith('device-ok', 'conv-2', USER, DEVICE);
  });

  it('does not throw if loading pending provisions fails', async () => {
    mockDeviceRepo.getPendingProvisions.and.returnValue(Promise.reject(new Error('network down')));

    await expectAsync(service.checkAndProvisionOnConnect(USER, DEVICE)).toBeResolved();
    expect(mockCoordinator.provisionDevice).not.toHaveBeenCalled();
  });
});

// ── Revoked-device leaf removal on reconnect (forensic audit finding F11) ──
// device:revoked is an ephemeral socket event with no durable replay -- a
// revocation that happens while every member is offline was otherwise never
// retried, leaving the revoked device's MLS leaf in place indefinitely.
// checkAndProvisionOnConnect() now also re-checks the backend's revoked-device
// list on every reconnect and re-attempts removal, independent of whether the
// account has any other own devices at all.
describe('DeviceProvisioningService.checkAndProvisionOnConnect — revoked-device leaf removal (F11)', () => {
  let service: DeviceProvisioningService;
  let mockCoordinator: jasmine.SpyObj<MlsCoordinatorBase>;
  let mockConvSvc: jasmine.SpyObj<ConversationsService>;
  let mockDeviceRepo: jasmine.SpyObj<DeviceRepository>;

  const USER:   UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const DEVICE: DeviceInfo  = { id: 'device-a1', name: 'Phone', platform: 'android' };

  beforeEach(() => {
    mockCoordinator = jasmine.createSpyObj<MlsCoordinatorBase>('MlsCoordinatorBase', ['canProvision', 'provisionDevice', 'removeRevokedDeviceFromAllGroups']);
    mockConvSvc     = jasmine.createSpyObj<ConversationsService>('ConversationsService', ['getConversations']);
    mockDeviceRepo  = jasmine.createSpyObj<DeviceRepository>('DeviceRepository', ['getPendingProvisions', 'getRevokedDevices']);

    TestBed.configureTestingModule({
      providers: [
        DeviceProvisioningService,
        { provide: MlsCoordinatorBase, useValue: mockCoordinator },
        { provide: ConversationsService, useValue: mockConvSvc },
        { provide: SyncService, useValue: jasmine.createSpyObj<SyncService>('SyncService', ['flush']) },
        { provide: DeviceRepository, useValue: mockDeviceRepo },
      ],
    });
    service = TestBed.inject(DeviceProvisioningService);
    mockCoordinator.removeRevokedDeviceFromAllGroups.and.returnValue(Promise.resolve());
    // Single-device account: no pending provisions, but revoked-device
    // reconciliation must still run (it's a separate, unconditional step).
    mockDeviceRepo.getPendingProvisions.and.returnValue(Promise.resolve({ data: [] }));
  });

  it('re-attempts leaf removal for a revoked conversation partner device even with no other own devices', async () => {
    mockDeviceRepo.getRevokedDevices.and.returnValue(Promise.resolve({
      data: [{ id: 'device-bob-old', userDid: 'did:plc:bob' }],
    }));

    await service.checkAndProvisionOnConnect(USER, DEVICE);

    expect(mockCoordinator.removeRevokedDeviceFromAllGroups).toHaveBeenCalledWith('device-bob-old', USER, DEVICE);
  });

  it('attempts removal for every revoked device returned, continuing past one that fails', async () => {
    mockDeviceRepo.getRevokedDevices.and.returnValue(Promise.resolve({
      data: [
        { id: 'device-bad', userDid: 'did:plc:bob' },
        { id: 'device-ok',  userDid: 'did:plc:carol' },
      ],
    }));
    mockCoordinator.removeRevokedDeviceFromAllGroups.and.callFake((id: string) =>
      id === 'device-bad' ? Promise.reject(new Error('boom')) : Promise.resolve());

    await service.checkAndProvisionOnConnect(USER, DEVICE);

    expect(mockCoordinator.removeRevokedDeviceFromAllGroups).toHaveBeenCalledWith('device-ok', USER, DEVICE);
  });

  it('does not throw if the revoked-devices list fails to load', async () => {
    mockDeviceRepo.getRevokedDevices.and.returnValue(Promise.reject(new Error('network down')));

    await expectAsync(service.checkAndProvisionOnConnect(USER, DEVICE)).toBeResolved();
    expect(mockCoordinator.removeRevokedDeviceFromAllGroups).not.toHaveBeenCalled();
  });

  // Regression test for a production incident: Socket.IO's default
  // reconnection (1-5s backoff, unbounded attempts) re-triggers
  // checkAndProvisionOnConnect on every reconnect. With a backlog of
  // revoked devices whose removal keeps failing, each reconnect re-attempted
  // ALL of them across every conversation, producing a burst of 60-80+
  // requests every few seconds and tripping backend rate limits. The sweep
  // must not repeat within its cooldown window.
  it('does not re-sweep revoked devices on a second call within the cooldown window', async () => {
    mockDeviceRepo.getRevokedDevices.and.returnValue(Promise.resolve({
      data: [{ id: 'device-stuck', userDid: 'did:plc:bob' }],
    }));

    await service.checkAndProvisionOnConnect(USER, DEVICE);
    expect(mockDeviceRepo.getRevokedDevices).toHaveBeenCalledTimes(1);
    expect(mockCoordinator.removeRevokedDeviceFromAllGroups).toHaveBeenCalledWith('device-stuck', USER, DEVICE);

    // Simulates a rapid reconnect immediately after (e.g. socket flapping).
    await service.checkAndProvisionOnConnect(USER, DEVICE);

    expect(mockDeviceRepo.getRevokedDevices).toHaveBeenCalledTimes(1);
    expect(mockCoordinator.removeRevokedDeviceFromAllGroups).toHaveBeenCalledTimes(1);
  });
});
