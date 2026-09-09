import { TestBed } from '@angular/core/testing';
import { KeyPackageService } from './key-package.service';
import { KeyPackageRepository } from './key-package.repository';
import { MlsStateStorageService } from '../mls-state-storage.service';
import { MlsCryptoContextService } from '../mls-crypto-context.service';
import { AtprotoRepoService } from '../../auth/atproto-repo.service';
import { OAuthService } from '../../auth/oauth.service';
import { DidSignerService } from '../../auth/did-signer.service';
import { BadgeVisibilityCacheRepository } from '../../badge/badge-visibility-cache.repository';
import { DeclarationVerificationCacheRepository } from '../../badge/declaration-verification-cache.repository';

/* eslint-disable @typescript-eslint/no-explicit-any */

// F8: refillPool must persist the private KeyPackage halves locally BEFORE
// publishing the public halves to the server. A crash in between used to
// leave the server serving KeyPackages this device has no private key for.
describe('KeyPackageService.refillPool ordering (F8)', () => {
  let service: KeyPackageService;
  let mockRepo:    any;
  let mockStorage: any;
  let mockSigner:  any;
  const calls: string[] = [];

  const record = (b64: string): any => ({
    serverId: null, deviceId: 'device-a1', serializedKeyPackage: b64,
    privatePackage: `priv-${b64}`, createdAt: Date.now(),
  });

  beforeEach(() => {
    calls.length = 0;
    mockRepo    = jasmine.createSpyObj('KeyPackageRepository', ['getCount', 'upload']);
    mockStorage = jasmine.createSpyObj('MlsStateStorageService', ['update', 'load']);
    mockSigner  = jasmine.createSpyObj('DidSignerService', ['signPayload']);

    mockStorage.load.and.returnValue(Promise.resolve(null));
    mockSigner.signPayload.and.returnValue(Promise.resolve(undefined));
    mockStorage.update.and.callFake(async (_scope: string, updater: (s: any) => Promise<any>) => {
      calls.push('append/update');
      await updater({ keyPackages: [], userDid: 'did:plc:alice' });
    });
    mockRepo.upload.and.callFake(async (kps: string[]) => {
      calls.push('upload');
      return { data: kps.map(k => ({ id: `srv-${k}`, keyPackage: k, deviceId: 'device-a1', createdAt: 0 })) };
    });

    TestBed.configureTestingModule({
      providers: [
        KeyPackageService,
        { provide: KeyPackageRepository, useValue: mockRepo },
        { provide: MlsStateStorageService, useValue: mockStorage },
        { provide: MlsCryptoContextService, useValue: {
          makeScope: () => 'mls:did:plc:alice:device-a1',
          base64ToBytes: () => new Uint8Array(),
          sha256hex: () => Promise.resolve('deadbeef'),
        } },
        { provide: AtprotoRepoService, useValue: {} },
        { provide: OAuthService, useValue: {} },
        { provide: DidSignerService, useValue: mockSigner },
        { provide: BadgeVisibilityCacheRepository, useValue: {} },
        { provide: DeclarationVerificationCacheRepository, useValue: {} },
      ],
    });
    service = TestBed.inject(KeyPackageService);

    // Stub the private generator so the test doesn't run real ts-mls crypto.
    spyOn(service as any, 'generateKeyPackages').and.returnValue(Promise.resolve([record('kp-a'), record('kp-b')]));
  });

  it('persists the local records before uploading to the server', async () => {
    await service.refillPool('did:plc:alice', 'device-a1', 2);

    expect(calls[0]).toBe('append/update');
    expect(calls.indexOf('upload')).toBeGreaterThan(calls.indexOf('append/update'));
  });

  it('backfills server ids after a successful upload', async () => {
    const state: any = { keyPackages: [record('kp-a'), record('kp-b')] };
    mockStorage.update.and.callFake(async (_scope: string, updater: (s: any) => Promise<any>) => {
      await updater(state);
    });

    await service.refillPool('did:plc:alice', 'device-a1', 2);

    expect(state.keyPackages[0].serverId).toBe('srv-kp-a');
    expect(state.keyPackages[1].serverId).toBe('srv-kp-b');
  });

  it('does not throw if the serverId backfill write fails', async () => {
    let n = 0;
    mockStorage.update.and.callFake(async (_scope: string, updater: (s: any) => Promise<any>) => {
      n++;
      if (n === 1) { await updater({ keyPackages: [] }); return; }
      throw new Error('storage down');
    });

    await expectAsync(service.refillPool('did:plc:alice', 'device-a1', 2)).toBeResolved();
    expect(mockRepo.upload).toHaveBeenCalled();
  });
});
