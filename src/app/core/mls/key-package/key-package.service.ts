import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  encodeMlsMessage,
  generateKeyPackage,
  type Credential,
} from 'ts-mls';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { environment } from '../../../../environments/environment';
import { KeyPackageRepository } from './key-package.repository';
import { MlsStateStorageService } from '../mls-state-storage.service';
import { MlsCryptoContextService } from '../mls-crypto-context.service';
import { AtprotoRepoService } from '../../auth/atproto-repo.service';
import type { KeyPackageCountResponse, KeyPackagePoolStatus } from './key-package.types';
import type { StoredKeyPackageRecord, StoredMlsState } from '../mls.types';

export type { KeyPackageCountResponse, KeyPackagePoolStatus } from './key-package.types';

const KP_TARGET    = 20;
const KP_THRESHOLD = 10;

@Injectable({ providedIn: 'root' })
export class KeyPackageService {
  private readonly kpRepo      = inject(KeyPackageRepository);
  private readonly cryptoCtx   = inject(MlsCryptoContextService);
  private readonly atprotoRepo = inject(AtprotoRepoService);
  private readonly storage     = inject(MlsStateStorageService);

  private _poolStatus:   KeyPackagePoolStatus = 'idle';
  private ensurePromise?: Promise<void>;

  get poolStatus(): KeyPackagePoolStatus { return this._poolStatus; }

  async ensureKeyPackagePool(userDid: string, deviceId: string): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;

    this.ensurePromise = this.runEnsure(userDid, deviceId).finally(() => {
      this.ensurePromise = undefined;
    });

    return this.ensurePromise;
  }

  async getServerCount(): Promise<KeyPackageCountResponse> {
    return this.kpRepo.getCount();
  }

  async refillPool(userDid: string, deviceId: string, toGenerate: number): Promise<void> {
    const count = Math.max(0, Math.min(toGenerate, KP_TARGET));
    if (count === 0) return;

    const generated = await this.generateKeyPackages(userDid, deviceId, count);
    if (generated.length === 0) return;

    const uploaded = await this.kpRepo.upload(generated.map(r => r.serializedKeyPackage));

    const idsByPayload = new Map(uploaded.data.map(item => [item.keyPackage, item.id]));
    generated.forEach(r => {
      r.serverId = idsByPayload.get(r.serializedKeyPackage) ?? null;
    });

    if (!environment.production) {
      console.log(`[MLS:trace:3] refillPool  uploading ${generated.length} KP(s)`);
      generated.forEach((r, i) => {
        console.log(`[MLS:trace:3]   index=${i}  serverId=${r.serverId}  b64fp=${r.serializedKeyPackage.substring(0, 48)}`);
      });
    }

    await this.appendKeyPackagesToState(userDid, deviceId, generated);
  }

  async syncDeclaration(userDid: string, deviceId: string): Promise<void> {
    try {
      const state = await this.storage.load<StoredMlsState>(this.cryptoCtx.getStorageScope(userDid, deviceId));
      if (!state) return;

      const rec = state.keyPackages?.find(k => k.serverId !== null);
      if (!rec) return;

      const binary = this.base64ToBytes(rec.serializedKeyPackage);
      const decoded = decodeMlsMessage(binary, 0);
      const msg = decoded?.[0];
      if (!msg || msg.wireformat !== 'mls_key_package') return;

      const signatureKey = msg.keyPackage?.leafNode?.signaturePublicKey;
      if (!signatureKey) return;

      const cacheKey = `bluvy-published-key-${userDid}`;
      const cachedHex = sessionStorage.getItem(cacheKey);
      const currentHex = (Array.from(signatureKey) as number[]).map(x => x.toString(16).padStart(2, '0')).join('');

      if (cachedHex === currentHex) return;

      await this.atprotoRepo.publishDeclaration(signatureKey, 'everyone');
      sessionStorage.setItem(cacheKey, currentHex);
    } catch (err) {
      if (!environment.production) console.error('[KeyPackageService] syncDeclaration failed:', err);
    }
  }

  private base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async handleNoKeyPackages<T>(
    userDid:   string,
    deviceId:  string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      const errCode = (err as { error?: { error?: { code?: string }; code?: string } })?.error?.error?.code || (err as { error?: { code?: string } })?.error?.code;
      if (
        err instanceof HttpErrorResponse &&
        errCode === 'NO_KEY_PACKAGES'
      ) {
        if (!environment.production) console.warn('[KeyPackageService] NO_KEY_PACKAGES — refilling pool and retrying once');
        await this.refillPool(userDid, deviceId, KP_THRESHOLD);
        return await operation();
      }
      throw err;
    }
  }

  private async runEnsure(userDid: string, deviceId: string): Promise<void> {
    this._poolStatus = 'checking';

    let countResp: KeyPackageCountResponse;
    try {
      countResp = await this.getServerCount();
    } catch (err) {
      this._poolStatus = 'error';
      if (!environment.production) console.error('[KeyPackageService] ensureKeyPackagePool: failed to get server count', err);
      return;
    }

    if (!countResp.needsRefill) {
      this._poolStatus = 'idle';
      await this.syncDeclaration(userDid, deviceId);
      return;
    }

    this._poolStatus = 'refilling';
    try {
      await this.refillPool(userDid, deviceId, KP_TARGET - countResp.count);
      this._poolStatus = 'idle';
      await this.syncDeclaration(userDid, deviceId);
    } catch (err) {
      this._poolStatus = 'error';
      throw err;
    }
  }

  // Generates fresh key package records for a device. Moved from MlsService
  // (Phase 1 Step 5 of the mls.service.ts split) -- KeyPackageService was
  // already this method's only caller, so the cross-service reach-through
  // just added indirection with no benefit.
  private async generateKeyPackages(
    userDid:  string,
    deviceId: string,
    count:    number,
  ): Promise<StoredKeyPackageRecord[]> {
    if (count <= 0) return [];

    const credentialIdentity = this.cryptoCtx.buildCredentialIdentity(userDid, deviceId);
    const cs = await this.cryptoCtx.getCiphersuiteImpl();
    const credential: Credential = {
      credentialType: 'basic',
      identity: new TextEncoder().encode(credentialIdentity),
    };

    const generated: StoredKeyPackageRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const keyPackage = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);

      generated.push({
        serverId:             null,
        deviceId,
        serializedKeyPackage: this.cryptoCtx.bytesToBase64(encodeMlsMessage({
          version:    'mls10',
          wireformat: 'mls_key_package',
          keyPackage: keyPackage.publicPackage,
        })),
        privatePackage: this.cryptoCtx.serializePrivatePackage(keyPackage.privatePackage),
        createdAt:      Date.now(),
      });
      const _rec1       = generated[generated.length - 1]!;
      const _toHex1     = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      const _kpBytes1   = this.cryptoCtx.base64ToBytes(_rec1.serializedKeyPackage);
      const _kpSha256_1 = await this.cryptoCtx.sha256hex(_kpBytes1);
      const _kpRef1     = _toHex1(await makeKeyPackageRef(keyPackage.publicPackage, cs.hash));
      const _initSha1   = await this.cryptoCtx.sha256hex(keyPackage.privatePackage.initPrivateKey);
      if (!environment.production) console.log(`[MLS:trace:1] KP generated  index=${i}  deviceId=${deviceId}  sha256=${_kpSha256_1}  kpRef=${_kpRef1}  initPrivSha256=${_initSha1}  b64fp=${_rec1.serializedKeyPackage.substring(0, 48)}`);
    }

    return generated;
  }

  // Appends newly-uploaded key package records to local MLS state. Moved
  // from MlsService alongside generateKeyPackages -- same rationale.
  private async appendKeyPackagesToState(
    userDid:  string,
    deviceId: string,
    records:  StoredKeyPackageRecord[],
  ): Promise<void> {
    const scope = this.cryptoCtx.makeScope(userDid, deviceId);

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      // Deduplicate by serializedKeyPackage to prevent double-append on concurrent calls.
      const existingKPs = new Set(state.keyPackages.map(kp => kp.serializedKeyPackage));
      const fresh = records.filter(r => !existingKPs.has(r.serializedKeyPackage));
      state.keyPackages = [...state.keyPackages, ...fresh];
      if (!environment.production) {
        console.log(`[MLS:trace:2] appendKeyPackagesToState  total=${state.keyPackages.length}`);
        state.keyPackages.forEach((kp, i) => {
          console.log(`[MLS:trace:2]   slot=${i}  serverId=${kp.serverId}  b64fp=${kp.serializedKeyPackage.substring(0, 48)}`);
        });
      }
      state.updatedAt = Date.now();
      return state;
    });

    if (!environment.production) {
      const _verState = await this.storage.load<StoredMlsState>(scope);
      console.log(`[MLS:trace:2b] VERIFY post-append  stored=${_verState?.keyPackages.length}  submitted=${records.length}`);
      await Promise.all(records.map(async (r) => {
        const sha256In   = await this.cryptoCtx.sha256hex(this.cryptoCtx.base64ToBytes(r.serializedKeyPackage));
        const storedRec  = _verState?.keyPackages.find(k => k.serverId === r.serverId);
        const sha256Stor = storedRec
          ? await this.cryptoCtx.sha256hex(this.cryptoCtx.base64ToBytes(storedRec.serializedKeyPackage))
          : 'NOT_FOUND';
        const result = sha256In === sha256Stor ? 'IDENTICAL' : 'DIFFERENT ←';
        console.log(`[MLS:trace:2b]   serverId=${r.serverId}  sha256In=${sha256In}  sha256Stored=${sha256Stor}  result=${result}`);
      }));
    }
  }
}
