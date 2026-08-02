import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DevicesPage } from './devices.page';
import { DeviceRepository } from '../../core/device/device.repository';
import type { DeviceItem } from '../../core/device/device.repository';
import { AuthService } from '../../core/auth/auth.service';
import { SyncService } from '../../core/sync/sync.service';
import { TranslationService } from '../../core/i18n/translation.service';

describe('DevicesPage — MBK rotation flow', () => {
  let page: DevicesPage;
  let mockDeviceRepo: jasmine.SpyObj<DeviceRepository>;
  let mockAuthSvc: jasmine.SpyObj<AuthService>;
  let mockSyncSvc: jasmine.SpyObj<SyncService>;
  let mockRouter: jasmine.SpyObj<Router>;

  const OTHER_DEVICE: DeviceItem = { id: 'device-2', name: 'Old Phone', platform: 'android', lastSeen: Date.now(), createdAt: Date.now() };

  beforeEach(() => {
    mockDeviceRepo = jasmine.createSpyObj<DeviceRepository>('DeviceRepository', ['getMyDevices', 'revokeDevice', 'revokeAllDevices']);
    mockAuthSvc    = jasmine.createSpyObj<AuthService>('AuthService', ['currentDevice']);
    mockSyncSvc    = jasmine.createSpyObj<SyncService>('SyncService', ['rotateMbk']);
    mockRouter     = jasmine.createSpyObj<Router>('Router', ['navigate']);

    mockAuthSvc.currentDevice.and.returnValue({ id: 'device-1', name: 'This Device', platform: 'web' });
    mockDeviceRepo.getMyDevices.and.returnValue(Promise.resolve({ data: [OTHER_DEVICE] }));

    TestBed.configureTestingModule({
      providers: [
        DevicesPage,
        { provide: DeviceRepository, useValue: mockDeviceRepo },
        { provide: AuthService, useValue: mockAuthSvc },
        { provide: SyncService, useValue: mockSyncSvc },
        { provide: Router, useValue: mockRouter },
        // TranslationService.t() is used only to build user-facing strings --
        // the real implementation is pure and side-effect-free, no need to mock.
        TranslationService,
      ],
    });

    page = TestBed.inject(DevicesPage);
    page.devices = [OTHER_DEVICE];
  });

  describe('revoke() / revokeAll() — opens the rotation modal on success', () => {
    it('revoke() opens the PIN step after a successful revocation', async () => {
      mockDeviceRepo.revokeDevice.and.returnValue(Promise.resolve());

      await page.revoke(OTHER_DEVICE);

      expect(page.rotationModalOpen).toBe(true);
      expect(page.rotationStep).toBe('pin');
      expect(page.rotationError).toBe('');
      expect(page.rotationAcknowledged).toBe(false);
    });

    it('revoke() does not open the modal when the revocation itself fails', async () => {
      mockDeviceRepo.revokeDevice.and.returnValue(Promise.reject(new Error('network error')));

      await page.revoke(OTHER_DEVICE);

      expect(page.rotationModalOpen).toBe(false);
      expect(page.error).toBeTruthy();
    });

    it('revokeAll() opens the PIN step after a successful bulk revocation', async () => {
      mockDeviceRepo.revokeAllDevices.and.returnValue(Promise.resolve({ revokedCount: 1 }));

      await page.revokeAll();

      expect(page.rotationModalOpen).toBe(true);
      expect(page.rotationStep).toBe('pin');
    });
  });

  describe('confirmRotationPin()', () => {
    beforeEach(() => {
      page.rotationModalOpen = true;
      page.rotationStep      = 'pin';
      page.rotationPin       = '123456';
    });

    it('advances to the key step and stores the new Recovery Key on success', async () => {
      mockSyncSvc.rotateMbk.and.returnValue(Promise.resolve({ recoveryKey: 'ABCD1234EFGH5678' }));

      await page.confirmRotationPin();

      expect(page.rotationStep).toBe('key');
      expect(page.newRecoveryKey).toBe('ABCD1234EFGH5678');
      expect(page.newRecoveryChunks.join('')).toBe('ABCD1234EFGH5678');
      expect(page.rotationPin).toBe('');
      expect(page.rotationError).toBe('');
    });

    it('shows the wrong-PIN message and stays on the PIN step when the PIN is incorrect', async () => {
      mockSyncSvc.rotateMbk.and.returnValue(Promise.reject(new Error('Incorrect PIN')));

      await page.confirmRotationPin();

      expect(page.rotationStep).toBe('pin');
      expect(page.rotationError).toBeTruthy();
      expect(page.newRecoveryKey).toBe('');
    });

    it('shows a generic message for any other rotation failure', async () => {
      mockSyncSvc.rotateMbk.and.returnValue(Promise.reject(new Error('network down')));

      await page.confirmRotationPin();

      expect(page.rotationStep).toBe('pin');
      expect(page.rotationError).toBeTruthy();
    });
  });

  describe('cancelRotation() / finishRotation()', () => {
    it('cancelRotation() closes the modal without calling rotateMbk', () => {
      page.rotationModalOpen = true;
      page.rotationPin       = '123456';

      page.cancelRotation();

      expect(page.rotationModalOpen).toBe(false);
      expect(page.rotationPin).toBe('');
      expect(mockSyncSvc.rotateMbk).not.toHaveBeenCalled();
    });

    it('finishRotation() closes the modal', () => {
      page.rotationModalOpen = true;
      page.rotationStep      = 'key';

      page.finishRotation();

      expect(page.rotationModalOpen).toBe(false);
    });
  });
});
