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
import { AtprotoRepoService, BLUVY_MESSAGE_URL } from '../../auth/atproto-repo.service';
import { OAuthService } from '../../auth/oauth.service';
import { DidSignerService } from '../../auth/did-signer.service';
import { BadgeVisibilityCacheRepository } from '../../badge/badge-visibility-cache.repository';
import { DEFAULT_BADGE_VISIBILITY } from '../../badge/badge-visibility.types';
import { DeclarationVerificationCacheRepository } from '../../badge/declaration-verification-cache.repository';
import type { KeyPackageCountResponse, KeyPackagePoolStatus } from './key-package.types';
import type { StoredKeyPackageRecord, StoredMlsState } from '../mls.types';

export type { KeyPackageCountResponse, KeyPackagePoolStatus } from './key-package.types';

const KP_TARGET    = 20;
const KP_THRESHOLD = 10;

// F8 orphan cleanup: while false, reconcileServerPool() only LOGS the server
// key packages it can't back with a local private key. Flip to true in a
// follow-up commit once production logs confirm there are no false positives.
const RECONCILE_DELETE = false;

// How often syncDeclaration() is allowed to actually read the declaration
// back from the PDS to verify it hasn't drifted (wrong URL, stale
// visibility, etc.) when the local device key hasn't changed. Keeps launch
// time free of an unconditional network round trip on every app open.
const DECLARATION_VERIFY_INTERVAL_MS = 60 * 60 * 1000; // 1h

@Injectable({ providedIn: 'root' })
export class KeyPackageService {
  private readonly kpRepo        = inject(KeyPackageRepository);
  private readonly cryptoCtx     = inject(MlsCryptoContextService);
  private readonly atprotoRepo   = inject(AtprotoRepoService);
  private readonly oauth         = inject(OAuthService);
  private readonly didSigner      = inject(DidSignerService);
  private readonly storage       = inject(MlsStateStorageService);
  private readonly badgeCache    = inject(BadgeVisibilityCacheRepository);
  private readonly verifyCache   = inject(DeclarationVerificationCacheRepository);

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

    // Persist the private halves locally BEFORE publishing the public
    // KeyPackages to the server. A crash between the two used to leave the
    // server holding KeyPackages this device has no private key for; since
    // consumeKeyPackage() serves newest-first, discovery then handed one of
    // those orphans to a conversation initiator, whose otherwise-valid
    // Welcome the invited device could never join ("no matching key
    // package") -- the conversation went FAILED on the invited side while
    // the initiator sat at epoch 1. A KeyPackage present locally but not yet
    // on the server is harmless: it just isn't consumable until a later
    // refill uploads it.
    await this.appendKeyPackagesToState(userDid, deviceId, generated);

    const kpList = generated.map(r => r.serializedKeyPackage);
    const signedPayload = await this.didSigner.signPayload(kpList, userDid).catch(err => {
      if (!environment.production) console.warn('[KeyPackageService] DID signature creation skipped/failed:', err);
      return undefined;
    });

    const uploaded = await this.kpRepo.upload(kpList, signedPayload);

    const idsByPayload = new Map(uploaded.data.map(item => [item.keyPackage, item.id]));

    if (!environment.production) {
      console.log(`[MLS:trace:3] refillPool  uploaded ${generated.length} KP(s) (signed: ${!!signedPayload})`);
      generated.forEach((r, i) => {
        console.log(`[MLS:trace:3]   index=${i}  serverId=${idsByPayload.get(r.serializedKeyPackage) ?? null}  b64fp=${r.serializedKeyPackage.substring(0, 48)}`);
      });
    }

    // Backfill the server ids onto the records just persisted. If this write
    // fails the KeyPackages stay usable (their private keys are local); the
    // only cost is getCurrentSignatureKey()'s serverId filter, which now
    // falls back to any local record.
    await this.backfillKeyPackageServerIds(userDid, deviceId, idsByPayload);
  }

  private async backfillKeyPackageServerIds(
    userDid:  string,
    deviceId: string,
    idsByPayload: Map<string, string>,
  ): Promise<void> {
    if (idsByPayload.size === 0) return;
    try {
      const scope = this.cryptoCtx.makeScope(userDid, deviceId);
      await this.storage.update<StoredMlsState>(scope, async (state) => {
        if (!state?.keyPackages) return state ?? null;
        let changed = false;
        for (const kp of state.keyPackages) {
          const serverId = idsByPayload.get(kp.serializedKeyPackage);
          if (serverId && kp.serverId !== serverId) { kp.serverId = serverId; changed = true; }
        }
        if (!changed) return null;
        state.updatedAt = Date.now();
        return state;
      });
    } catch (err) {
      if (!environment.production) console.warn('[KeyPackageService] backfillKeyPackageServerIds failed (KeyPackages still usable):', err);
    }
  }

  /**
   * Keeps com.bluvy.declaration in sync with this device's current MLS key
   * and the user's saved badge-visibility preference. Called at every app
   * launch / session restore (see AuthService), so it's split into two
   * cheap-by-default checks rather than one unconditional network call:
   *
   *  1. Local key-hash comparison (sessionStorage) -- catches key rotation
   *     within this session and publishes unconditionally when it fires,
   *     since we already know the record must change.
   *  2. Throttled PDS verification (DeclarationVerificationCacheRepository,
   *     persisted across relaunches) -- actually reads the live record back
   *     at most once per hour and republishes if it has drifted from what
   *     it should be (wrong URL -- e.g. a stale dev-origin messageMeUrl
   *     published before a prod release -- or a stale showButtonTo). This
   *     is what guarantees the published URL is eventually always correct
   *     even if step 1 never fires (key unchanged) or a previous publish
   *     wrote a bad value.
   */
  async syncDeclaration(userDid: string, deviceId: string): Promise<void> {
    const log = (...args: unknown[]) => {
      if (!environment.production) console.log('[KeyPackageService:syncDeclaration]', ...args);
    };

    try {
      const signatureKey = await this.getCurrentSignatureKey(userDid, deviceId);
      if (!signatureKey) {
        log('skipped: no local MLS signature key yet for', userDid, deviceId);
        return;
      }

      // publishDeclaration()/getDeclaration() both silently no-op without a
      // live ATProto OAuth session (a credential separate from -- and that
      // can lag behind -- the app's own backend login session). ensureSession()
      // proactively restores it and flips OAuthService.sessionUnavailable when
      // it can't, which AppComponent watches to prompt the user to reconnect.
      const session = await this.oauth.ensureSession(userDid);
      if (!session) {
        log('skipped: no ATProto OAuth session available -- cannot read or write the declaration');
        return;
      }

      const keyCacheKey = `bluvy-published-key-${userDid}`;
      const cachedHex = sessionStorage.getItem(keyCacheKey);
      const currentHex = (Array.from(signatureKey) as number[]).map(x => x.toString(16).padStart(2, '0')).join('');
      const keyChanged = cachedHex !== currentHex;

      const showButtonTo = (await this.badgeCache.getCached(userDid)) ?? DEFAULT_BADGE_VISIBILITY;

      if (keyChanged) {
        // Key rotated -- we know the record must be rewritten, no need to
        // read it first.
        log('device key changed, publishing declaration');
        await this.atprotoRepo.publishDeclaration(signatureKey, showButtonTo);
        sessionStorage.setItem(keyCacheKey, currentHex);
        await this.verifyCache.setVerifiedNow(userDid);
        return;
      }

      const lastVerifiedAt = await this.verifyCache.getLastVerifiedAt(userDid);
      const msSinceVerified = Date.now() - lastVerifiedAt;
      if (msSinceVerified < DECLARATION_VERIFY_INTERVAL_MS) {
        log(`skipped: verified ${Math.round(msSinceVerified / 1000)}s ago, within the 1h window`);
        return;
      }

      log('verification window elapsed, reading declaration from PDS');
      const record = await this.atprotoRepo.getDeclaration();
      const isCorrect =
        !!record &&
        record.messageMe?.messageMeUrl === BLUVY_MESSAGE_URL &&
        record.messageMe?.showButtonTo === showButtonTo;

      if (!isCorrect) {
        log('declaration drifted (record:', record, ') -- republishing');
        await this.atprotoRepo.publishDeclaration(signatureKey, showButtonTo);
      } else {
        log('declaration already correct');
      }
      await this.verifyCache.setVerifiedNow(userDid);
    } catch (err) {
      if (!environment.production) console.error('[KeyPackageService] syncDeclaration failed:', err);
    }
  }

  /**
   * Extracts the current device's MLS leaf-node signature public key (the
   * same value syncDeclaration() publishes as com.bluvy.declaration's
   * currentKey) without touching the PDS. Used by BadgeVisibilityService to
   * republish the declaration immediately when the user changes their
   * visibility preference, independent of the key-rotation-triggered sync.
   */
  async getCurrentSignatureKey(userDid: string, deviceId: string): Promise<Uint8Array | null> {
    const state = await this.storage.load<StoredMlsState>(this.cryptoCtx.getStorageScope(userDid, deviceId));
    if (!state) return null;

    // Prefer a server-confirmed record; fall back to any local one (a refill
    // whose serverId backfill hasn't landed yet -- the signature key is still
    // this device's own, valid for the declaration's currentKey).
    const rec = state.keyPackages?.find(k => k.serverId !== null) ?? state.keyPackages?.[0];
    if (!rec) return null;

    const binary = this.base64ToBytes(rec.serializedKeyPackage);
    const decoded = decodeMlsMessage(binary, 0);
    const msg = decoded?.[0];
    if (!msg || msg.wireformat !== 'mls_key_package') return null;

    return msg.keyPackage?.leafNode?.signaturePublicKey ?? null;
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

  // F8 orphan cleanup: a crash before the private halves were persisted (old
  // ordering) could leave the server serving key packages this device can't
  // use. consumeKeyPackage is newest-first, so discovery is *more* likely to
  // hand one of those to a conversation initiator, whose Welcome the invited
  // device could then never join. Delete any server key package whose payload
  // isn't in local state. Gated on RECONCILE_DELETE (log-only until proven
  // safe in prod). Never throws.
  private async reconcileServerPool(userDid: string, deviceId: string): Promise<void> {
    try {
      const scope = this.cryptoCtx.getStorageScope(userDid, deviceId);
      const state = await this.storage.load<StoredMlsState>(scope);
      // Empty/absent local state means "restore needed", not "orphans" --
      // deleting here would destroy a pool the device legitimately owns.
      if (!state?.keyPackages?.length) return;

      const localPayloads = new Set(state.keyPackages.map(k => k.serializedKeyPackage));

      let cursor: string | undefined;
      let orphans = 0;
      for (;;) {
        const page = await this.kpRepo.listMine(cursor);
        for (const serverKp of page.data) {
          if (localPayloads.has(serverKp.keyPackage)) continue;
          orphans++;
          console.warn('[KeyPackageService] orphan KP detected (no local private key):', serverKp.id,
            RECONCILE_DELETE ? '— deleting' : '— log-only');
          if (RECONCILE_DELETE) {
            await this.kpRepo.deleteById(serverKp.id).catch(err => {
              if (!environment.production) console.warn('[KeyPackageService] orphan KP delete failed:', serverKp.id, err);
            });
          }
        }
        if (!page.cursor) break;
        cursor = page.cursor;
      }

      if (orphans > 0 && !environment.production) {
        console.log(`[KeyPackageService] reconcileServerPool: ${orphans} orphan(s), delete=${RECONCILE_DELETE}`);
      }
    } catch (err) {
      if (!environment.production) console.warn('[KeyPackageService] reconcileServerPool failed:', err);
    }
  }

  private async runEnsure(userDid: string, deviceId: string): Promise<void> {
    this._poolStatus = 'checking';

    // Before checking the count / refilling: drop any server key package this
    // device can't back locally, so the top-up below refills the gap (F8).
    await this.reconcileServerPool(userDid, deviceId);

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
