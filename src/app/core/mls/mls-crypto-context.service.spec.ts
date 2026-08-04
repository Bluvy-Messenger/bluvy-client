import { TestBed } from '@angular/core/testing';
import {
  createGroup,
  encodeGroupState,
  generateKeyPackage,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  defaultCryptoProvider,
  defaultCapabilities,
  defaultLifetime,
} from 'ts-mls';
import { MlsCryptoContextService } from './mls-crypto-context.service';

const CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

async function getCs() {
  return getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE_NAME), defaultCryptoProvider);
}

describe('MlsCryptoContextService', () => {
  let service: MlsCryptoContextService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MlsCryptoContextService] });
    service = TestBed.inject(MlsCryptoContextService);
  });

  describe('restoreClientState', () => {
    it('round-trips a real MLS group state and exposes the seeded member', async () => {
      const cs = await getCs();
      const identity = 'did:plc:alice#device-a1';
      const credential = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identity) };
      const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
      const groupId = new TextEncoder().encode('conv-1');
      const state = await createGroup(groupId, kp.publicPackage, kp.privatePackage, [], cs);
      const stateB64 = service.bytesToBase64(encodeGroupState(state));

      const restored = service.restoreClientState(stateB64);

      expect(restored.groupContext.epoch).toBe(0n);
      expect(service.isDeviceMember(restored, 'device-a1')).toBe(true);
      expect(service.isDeviceMember(restored, 'device-unknown')).toBe(false);
    });

    it('throws on an undecodable payload', () => {
      const garbage = service.bytesToBase64(new Uint8Array([1, 2, 3]));
      expect(() => service.restoreClientState(garbage)).toThrow();
    });
  });

  describe('getCiphersuiteImpl', () => {
    it('memoizes the ciphersuite impl across calls (same promise instance)', () => {
      const p1 = service.getCiphersuiteImpl();
      const p2 = service.getCiphersuiteImpl();
      expect(p1).toBe(p2);
    });

    it('resolves to a usable ciphersuite implementation', async () => {
      const cs = await service.getCiphersuiteImpl();
      expect(cs).toBeTruthy();
    });
  });

  describe('naming helpers', () => {
    it('buildCredentialIdentity joins userDid and deviceId with #', () => {
      expect(service.buildCredentialIdentity('did:plc:alice', 'device-a1')).toBe('did:plc:alice#device-a1');
    });

    it('makeScope and getStorageScope agree and are prefixed with mls:', () => {
      expect(service.makeScope('did:plc:alice', 'device-a1')).toBe('mls:did:plc:alice:device-a1');
      expect(service.getStorageScope('did:plc:alice', 'device-a1')).toBe(service.makeScope('did:plc:alice', 'device-a1'));
    });
  });

  describe('byte/base64 conversion', () => {
    it('round-trips arbitrary bytes through bytesToBase64/base64ToBytes', () => {
      const original = crypto.getRandomValues(new Uint8Array(37));
      const roundTripped = service.base64ToBytes(service.bytesToBase64(original));
      expect(Array.from(roundTripped)).toEqual(Array.from(original));
    });
  });

  describe('serializePrivatePackage', () => {
    it('base64-encodes each private key field losslessly', async () => {
      const cs = await getCs();
      const credential = { credentialType: 'basic' as const, identity: new TextEncoder().encode('did:plc:alice#device-a1') };
      const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);

      const serialized = service.serializePrivatePackage(kp.privatePackage);

      expect(Array.from(service.base64ToBytes(serialized.initPrivateKey))).toEqual(Array.from(kp.privatePackage.initPrivateKey));
      expect(Array.from(service.base64ToBytes(serialized.hpkePrivateKey))).toEqual(Array.from(kp.privatePackage.hpkePrivateKey));
      expect(Array.from(service.base64ToBytes(serialized.signaturePrivateKey))).toEqual(Array.from(kp.privatePackage.signaturePrivateKey));
    });
  });

  describe('sha256hex', () => {
    it('is deterministic and produces a 64-char lowercase hex digest', async () => {
      const data = new TextEncoder().encode('bluvy');
      const h1 = await service.sha256hex(data);
      const h2 = await service.sha256hex(data);

      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different digests for different inputs', async () => {
      const h1 = await service.sha256hex(new TextEncoder().encode('a'));
      const h2 = await service.sha256hex(new TextEncoder().encode('b'));
      expect(h1).not.toBe(h2);
    });
  });
});
