import { Injectable } from '@angular/core';
import {
  decodeGroupState,
  defaultAuthenticationService,
  defaultCryptoProvider,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type ClientConfig,
  type ClientState,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import type { PrivateKeyPackage } from 'ts-mls';
import type { SerializedPrivateKeyPackage } from './mls.types';

// Shared low-level MLS infrastructure: ciphersuite setup, group-state
// (de)serialization, credential/scope naming, and byte<->base64 conversion.
// Extracted from MlsService, which used to duplicate the ciphersuite-impl
// derivation and ClientConfig construction independently in 8 different
// methods. Every MLS sub-service (welcome, commit, membership, message
// crypto) depends on this rather than reimplementing it.
@Injectable({ providedIn: 'root' })
export class MlsCryptoContextService {
  readonly cipherSuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

  // Memoized: getCiphersuiteImpl(getCiphersuiteFromName(cipherSuiteName), defaultCryptoProvider)
  // is pure and constant for the app's lifetime (cipherSuiteName never
  // changes) -- previously re-derived independently in 8 different
  // MlsService methods on every call.
  private ciphersuiteImplPromise: Promise<Awaited<ReturnType<typeof getCiphersuiteImpl>>> | null = null;

  getCiphersuiteImpl(): Promise<Awaited<ReturnType<typeof getCiphersuiteImpl>>> {
    if (!this.ciphersuiteImplPromise) {
      this.ciphersuiteImplPromise = getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);
    }
    return this.ciphersuiteImplPromise;
  }

  restoreClientState(base64: string): ClientState {
    const bytes   = this.base64ToBytes(base64);
    const decoded = decodeGroupState(bytes, 0);
    if (!decoded) throw new Error('Failed to decode MLS group state');

    const [groupState] = decoded;
    const clientConfig: ClientConfig = {
      keyRetentionConfig:       { ...defaultKeyRetentionConfig, retainKeysForEpochs: 50 },
      lifetimeConfig:           defaultLifetimeConfig,
      keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
      paddingConfig:            defaultPaddingConfig,
      authService:              defaultAuthenticationService,
    };
    return { ...groupState, clientConfig };
  }

  isDeviceMember(clientState: ClientState, deviceId: string): boolean {
    const dec = new TextDecoder();
    return getGroupMembers(clientState).some((m: ReturnType<typeof getGroupMembers>[number]) =>
      m.credential.credentialType === 'basic' &&
      dec.decode(m.credential.identity).endsWith(`#${deviceId}`)
    );
  }

  buildCredentialIdentity(userDid: string, deviceId: string): string {
    return `${userDid}#${deviceId}`;
  }

  makeScope(userDid: string, deviceId: string): string {
    return `mls:${userDid}:${deviceId}`;
  }

  getStorageScope(userDid: string, deviceId: string): string {
    return this.makeScope(userDid, deviceId);
  }

  serializePrivatePackage(value: PrivateKeyPackage): SerializedPrivateKeyPackage {
    return {
      initPrivateKey:      this.bytesToBase64(value.initPrivateKey),
      hpkePrivateKey:      this.bytesToBase64(value.hpkePrivateKey),
      signaturePrivateKey: this.bytesToBase64(value.signaturePrivateKey),
    };
  }

  bytesToBase64(value: Uint8Array): string {
    let binary = '';
    value.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async sha256hex(data: Uint8Array<ArrayBufferLike>): Promise<string> {
    const copy = new Uint8Array(data);
    const buf  = await crypto.subtle.digest('SHA-256', copy);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
