import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { decodeMlsMessage } from 'ts-mls';
import { environment } from '../../../../environments/environment';
import { MlsService } from '../mls.service';
import { KeyPackageRepository } from './key-package.repository';
import { MlsStateStorageService } from '../mls-state-storage.service';
import { AtprotoRepoService } from '../../auth/atproto-repo.service';
import type { KeyPackageCountResponse, KeyPackagePoolStatus } from './key-package.types';
import type { StoredMlsState } from '../mls.types';

export type { KeyPackageCountResponse, KeyPackagePoolStatus } from './key-package.types';

const KP_TARGET    = 20;
const KP_THRESHOLD = 10;

@Injectable({ providedIn: 'root' })
export class KeyPackageService {
  private readonly kpRepo  = inject(KeyPackageRepository);
  private readonly mlsSvc  = inject(MlsService);
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

    const generated = await this.mlsSvc.generateKeyPackages(userDid, deviceId, count);
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

    await this.mlsSvc.appendKeyPackagesToState(userDid, deviceId, generated);
  }

  async syncDeclaration(userDid: string, deviceId: string): Promise<void> {
    try {
      const state = await this.storage.load<StoredMlsState>(this.mlsSvc.getStorageScope(userDid, deviceId));
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
      if (
        err instanceof HttpErrorResponse &&
        (err.error as { code?: string })?.code === 'NO_KEY_PACKAGES'
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
}
