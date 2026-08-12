import { Injector } from '@angular/core';
import {
  createGroup,
  createCommit,
  joinGroup,
  generateKeyPackage,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  defaultCryptoProvider,
  defaultCapabilities,
  defaultLifetime,
  defaultAuthenticationService,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  decodeGroupState,
  encodeMlsMessage,
  type ClientConfig,
  type ClientState,
  type PrivateKeyPackage,
  type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { ApiClientService } from '../../infrastructure/api-client.service';
import { MlsRepository } from '../mls.repository';
import { MlsStateStorageService } from '../mls-state-storage.service';
import { MlsCryptoContextService } from '../mls-crypto-context.service';
import { MlsCommitService } from '../mls-commit.service';
import { MlsMembershipService } from '../mls-membership.service';
import { MlsMessageCryptoService } from '../mls-message-crypto.service';
import { MlsPendingCommitTracker } from '../mls-pending-commit-tracker.service';
import { MlsBackupRegistry } from '../mls-backup-registry.service';
import { MlsEpochConflictBus } from '../mls-epoch-conflict-bus.service';
import type { UserProfile } from '../../auth/auth.types';
import type { DeviceInfo } from '../../device/device.types';
import type { StoredMlsState, ConsumedKeyPackageResponse } from '../mls.types';
import type {
  AcquireCommitLockResponse,
  EnsureGroupResponse,
  MissedCommitsResponse,
  MlsCommitItem,
  MlsMyDevicesResponse,
  PendingWelcomesResponse,
} from '../mls.validator';

// Real-crypto multi-device test harness — NOT production code.
//
// This module is imported only from *.spec.ts files, so it is never
// reachable from src/main.ts's import graph and is excluded from the
// production bundle (tsconfig.app.json roots the app build at an explicit
// `files` list, not a glob include, so an unreferenced file is never pulled
// in regardless of its name or folder).
//
// Purpose: exercise TWO OR MORE independent, simultaneously-live instances of
// the real MlsCommitService/MlsMembershipService/MlsMessageCryptoService
// (real ts-mls crypto throughout) against a single shared fake backend that
// faithfully mirrors bluvy-backend's storeMlsCommit contract (atomic
// dedup-by-(conversationId,epoch) + reject-non-continuous-epoch — see
// bluvy-backend/src/modules/mls/mls.service.ts:439-610, independently proven
// against real SQLite in bluvy-backend/src/modules/mls/mls.service.test.ts).
// This harness does not re-prove the backend's own atomicity; it exists to
// prove client-side CONVERGENCE — that two real device instances, racing
// concurrently, end up byte-identical — which nothing in the existing suite
// exercises (existing specs mock a single device's repo responses to
// simulate "what another device did", never run two real instances at once).

export const CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export class EpochGapError extends Error {
  constructor(public conversationId: string, public epoch: number, public expected: number) {
    super(`Epoch ${epoch} does not extend the commit chain for ${conversationId} (expected ${expected})`);
  }
}

export async function getCs() {
  return getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE_NAME), defaultCryptoProvider);
}

export async function generateDeviceIdentityKeyPackage(deviceId: string): Promise<ConsumedKeyPackageResponse> {
  const cs = await getCs();
  // Identity format mirrors production (`${did}#${deviceId}`) closely enough
  // for membership lookups (isDeviceMember / leaf-by-"#deviceId" suffix) to
  // work identically to real code — the did portion is irrelevant to those checks.
  const credential = { credentialType: 'basic' as const, identity: new TextEncoder().encode(`harness#${deviceId}`) };
  const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
  const keyPackageB64 = bytesToBase64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage: kp.publicPackage }));
  return { keyPackage: keyPackageB64, deviceId };
}

// ── Fake backend ────────────────────────────────────────────────────────────

export class FakeMlsBackend {
  private commitsByConv = new Map<string, MlsCommitItem[]>();
  private welcomesByTarget = new Map<string, Array<{ id: string; conversationId: string; welcome: string; createdAt: number }>>();
  private locks = new Map<string, string>();
  private seq = 0;
  private welcomeSeq = 0;

  // Artificial network latency, varied per test run to exercise different
  // interleavings — set via delayRangeMs. [0,0] (default) means "as fast as
  // possible", still genuinely concurrent since callers are not awaited
  // sequentially by the test.
  delayRangeMs: [number, number] = [0, 0];

  private async latency(): Promise<void> {
    const [min, max] = this.delayRangeMs;
    if (max <= 0) return;
    const ms = min + Math.random() * (max - min);
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  async acquireCommitLock(conversationId: string, deviceId: string): Promise<AcquireCommitLockResponse> {
    await this.latency();
    const holder = this.locks.get(conversationId);
    if (holder && holder !== deviceId) return { acquired: false };
    this.locks.set(conversationId, deviceId);
    return { acquired: true };
  }

  // Mirrors storeMlsCommit's exact contract (mls.service.ts:439-610):
  // dedup-by-(conversationId,epoch) returns the existing winner to a loser
  // instead of erroring; a non-continuous epoch is rejected (EPOCH_GAP); the
  // whole decision is made with NO `await` between the check and the insert,
  // matching the real backend's synchronous-body-inside-db.transaction()
  // shape that AUDIT_07 identified as the actual atomicity guarantee (not
  // just the SQL transaction wrapper).
  async postCommit(
    conversationId:  string,
    senderDeviceId:  string,
    commit:          string,
    epoch:           number,
    welcomes?:       Array<{ targetDeviceId: string; welcome: string }>,
  ): Promise<MlsCommitItem> {
    await this.latency();

    const rows = this.commitsByConv.get(conversationId) ?? [];
    const existing = rows.find(r => r.epoch === epoch);
    if (existing) return existing;

    const maxEpoch = rows.reduce((m, r) => Math.max(m, r.epoch), -1);
    if (epoch !== maxEpoch + 1) {
      throw new EpochGapError(conversationId, epoch, maxEpoch + 1);
    }

    const row: MlsCommitItem = { id: `commit-${++this.seq}`, conversationId, senderDeviceId, commit, epoch, createdAt: Date.now() };
    rows.push(row);
    this.commitsByConv.set(conversationId, rows);

    if (this.locks.get(conversationId) === senderDeviceId) this.locks.delete(conversationId);

    if (welcomes) {
      for (const w of welcomes) {
        const list = this.welcomesByTarget.get(w.targetDeviceId) ?? [];
        list.push({ id: `welcome-${++this.welcomeSeq}`, conversationId, welcome: w.welcome, createdAt: Date.now() });
        this.welcomesByTarget.set(w.targetDeviceId, list);
      }
    }

    return row;
  }

  async getMissedCommits(conversationId: string, afterEpoch: number): Promise<MissedCommitsResponse> {
    await this.latency();
    const rows = (this.commitsByConv.get(conversationId) ?? [])
      .filter(r => r.epoch >= afterEpoch)
      .sort((a, b) => a.epoch - b.epoch);
    return { data: rows };
  }

  async getPendingWelcomes(deviceId: string, conversationId: string): Promise<PendingWelcomesResponse> {
    await this.latency();
    const data = (this.welcomesByTarget.get(deviceId) ?? []).filter(w => w.conversationId === conversationId);
    return { data };
  }

  ackWelcome(deviceId: string, welcomeId: string): void {
    const list = this.welcomesByTarget.get(deviceId);
    if (!list) return;
    this.welcomesByTarget.set(deviceId, list.filter(w => w.id !== welcomeId));
  }

  getCommits(conversationId: string): MlsCommitItem[] {
    return [...(this.commitsByConv.get(conversationId) ?? [])].sort((a, b) => a.epoch - b.epoch);
  }

  isLocked(conversationId: string): boolean {
    return this.locks.has(conversationId);
  }
}

// ── Fake per-device storage (mirrors MlsStateStorageService's contract,
//    including its per-scope promise-chain lock — see
//    mls-state-storage.service.ts's own doc comment) ─────────────────────────

export class FakeMlsStorage {
  private readonly store = new Map<string, StoredMlsState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  seed(scope: string, state: StoredMlsState): void {
    this.store.set(scope, JSON.parse(JSON.stringify(state)));
  }

  async load<T>(scope: string): Promise<T | null> {
    const value = this.store.get(scope);
    return value ? (JSON.parse(JSON.stringify(value)) as T) : null;
  }

  update<T>(scope: string, updater: (state: T | null) => Promise<T | null>): Promise<void> {
    const prev = this.locks.get(scope) ?? Promise.resolve<unknown>(undefined);
    const current: Promise<void> = prev.then(
      () => this.runUpdate(scope, updater),
      () => this.runUpdate(scope, updater),
    );
    const gate: Promise<unknown> = current.then(() => undefined, () => undefined);
    this.locks.set(scope, gate);
    void gate.then(() => { if (this.locks.get(scope) === gate) this.locks.delete(scope); });
    return current;
  }

  private async runUpdate<T>(scope: string, updater: (state: T | null) => Promise<T | null>): Promise<void> {
    const current = await this.load<T>(scope);
    const next = await updater(current);
    if (next !== null) this.store.set(scope, next as unknown as StoredMlsState);
  }

  raw(scope: string): StoredMlsState | undefined {
    return this.store.get(scope);
  }
}

// ── Per-device fake repository, backed by a shared FakeMlsBackend ──────────

class FakeDeviceRepository extends MlsRepository {
  private readonly backend: FakeMlsBackend;
  private readonly deviceId: string;

  constructor(backend: FakeMlsBackend, deviceId: string) {
    super(); // runs inside an injection context — see the useFactory provider below
    this.backend  = backend;
    this.deviceId = deviceId;
  }

  override async acquireCommitLock(conversationId: string): Promise<AcquireCommitLockResponse> {
    return this.backend.acquireCommitLock(conversationId, this.deviceId);
  }

  override async postCommit(
    conversationId: string, commit: string, epoch: number,
    welcomes?: Array<{ targetDeviceId: string; welcome: string }>,
  ): Promise<MlsCommitItem> {
    return this.backend.postCommit(conversationId, this.deviceId, commit, epoch, welcomes);
  }

  override async getMissedCommits(conversationId: string, afterEpoch: number): Promise<MissedCommitsResponse> {
    return this.backend.getMissedCommits(conversationId, afterEpoch);
  }

  override async getPendingWelcomes(conversationId: string): Promise<PendingWelcomesResponse> {
    return this.backend.getPendingWelcomes(this.deviceId, conversationId);
  }

  override ackWelcome(welcomeId: string): Promise<unknown> {
    this.backend.ackWelcome(this.deviceId, welcomeId);
    return Promise.resolve();
  }

  // Not exercised by the scenarios in this harness; provided so the real
  // type is satisfied without touching production MlsRepository at all.
  override async ensureGroup(): Promise<EnsureGroupResponse> { throw new Error('not used by harness'); }
  override async consumeKeyPackage(): Promise<ConsumedKeyPackageResponse> { throw new Error('not used by harness'); }
  override async getKeyPackagesForParticipant(): Promise<never> { throw new Error('not used by harness'); }
  override async getMyDevices(): Promise<MlsMyDevicesResponse> { throw new Error('not used by harness'); }

  // provisionDevice() consumes a key package FOR the device being added —
  // the harness generates a fresh real ts-mls key package on demand so
  // provisionDevice's real crypto (createCommit with a real Add proposal)
  // has something genuine to consume.
  override async consumeOwnKeyPackage(newDeviceId: string): Promise<ConsumedKeyPackageResponse> {
    return generateDeviceIdentityKeyPackage(newDeviceId);
  }
}

// ── Device: one fully independent DI subtree per simulated device ─────────

export class Device {
  readonly injector: Injector;
  readonly storage: FakeMlsStorage;
  readonly commitSvc: MlsCommitService;
  readonly membershipSvc: MlsMembershipService;
  readonly messageCryptoSvc: MlsMessageCryptoService;
  readonly pendingCommitTracker: MlsPendingCommitTracker;

  constructor(
    readonly backend: FakeMlsBackend,
    readonly user: UserProfile,
    readonly device: DeviceInfo,
  ) {
    this.storage = new FakeMlsStorage();

    this.injector = Injector.create({
      providers: [
        // Never actually invoked (FakeDeviceRepository overrides every
        // MlsRepository method) — only present so MlsRepository's own
        // `inject(ApiClientService)` field initializer resolves instead of
        // throwing when Angular constructs FakeDeviceRepository below.
        { provide: ApiClientService, useValue: {} as ApiClientService },
        // useFactory (not useValue) so `new FakeDeviceRepository(...)` —
        // and therefore MlsRepository's base constructor — runs inside a
        // valid Angular injection context, required for its `inject()` call.
        { provide: MlsRepository, useFactory: () => new FakeDeviceRepository(backend, device.id) },
        { provide: MlsStateStorageService, useValue: this.storage },
        // Injector.create() with no `parent` does not implicitly resolve
        // providedIn:'root' tokens (that only happens when the injector
        // chain traces back to the app's real root environment injector,
        // which TestBed sets up but a bare Injector.create() does not) --
        // both must be listed explicitly.
        MlsBackupRegistry,
        MlsEpochConflictBus,
        MlsCryptoContextService,
        MlsPendingCommitTracker,
        MlsCommitService,
        MlsMembershipService,
        MlsMessageCryptoService,
      ],
    });

    this.commitSvc            = this.injector.get(MlsCommitService);
    this.membershipSvc        = this.injector.get(MlsMembershipService);
    this.messageCryptoSvc     = this.injector.get(MlsMessageCryptoService);
    this.pendingCommitTracker = this.injector.get(MlsPendingCommitTracker);
  }

  get scope(): string {
    return `mls:${this.user.did}:${this.device.id}`;
  }

  seedGroupState(conversationId: string, groupStateB64: string): void {
    const existing = this.storage.raw(this.scope);
    const groupStates = existing?.groupStates ?? {};
    groupStates[conversationId] = groupStateB64;
    this.storage.seed(this.scope, existing ? { ...existing, groupStates } : baseState(this.user, this.device, groupStates));
  }

  getGroupStateB64(conversationId: string): string | undefined {
    return this.storage.raw(this.scope)?.groupStates[conversationId];
  }

  // Decodes this device's own current ClientState for a conversation --
  // mirrors MlsCryptoContextService.restoreClientState() exactly, so tests
  // can inspect epoch/membership the same way production code does.
  getClientState(conversationId: string): ClientState {
    const b64 = this.getGroupStateB64(conversationId);
    if (!b64) throw new Error(`harness: no group state for ${conversationId} on device ${this.device.id}`);
    return restoreClientStateB64(b64);
  }

  epoch(conversationId: string): number {
    return Number(this.getClientState(conversationId).groupContext.epoch);
  }

  // Member identities as the `#deviceId` suffix production code matches on
  // (see removeRevokedDeviceFromAllGroups' / provisionDevice's own lookups).
  memberDeviceIds(conversationId: string): string[] {
    const dec = new TextDecoder();
    return getGroupMembers(this.getClientState(conversationId))
      .filter(m => m.credential.credentialType === 'basic')
      .map(m => dec.decode((m.credential as { identity: Uint8Array }).identity))
      .map(identity => identity.split('#').pop() ?? identity);
  }
}

export function restoreClientStateB64(base64: string): ClientState {
  const decoded = decodeGroupState(base64ToBytes(base64), 0);
  if (!decoded) throw new Error('harness: failed to decode group state');
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

export function baseState(user: UserProfile, device: DeviceInfo, groupStates: Record<string, string>): StoredMlsState {
  return {
    version:            1,
    userDid:            user.did,
    deviceId:           device.id,
    deviceName:         device.name,
    platform:           device.platform,
    cipherSuiteName:    CIPHERSUITE_NAME,
    credentialIdentity: `${user.did}#${device.id}`,
    keyPackages:        [],
    conversations:      {},
    groupStates,
    initializedAt:      Date.now(),
    updatedAt:          Date.now(),
  };
}

// ── Real-group construction helper (same idiom as mls-membership.service.spec.ts) ──

// Builds a real N-member MLS group (founder + N-1 joiners) entirely in
// memory via real ts-mls calls, and seeds each corresponding Device's
// storage with its own post-join ClientState — exactly what a real Welcome
// round would produce, without going through the harness's own
// commit/welcome plumbing (that plumbing is what the tests exercise on top
// of this known-good starting point).
//
// The founding commit (epoch 0, the one that adds every joiner) is also
// registered directly in `backend` as if the founder had posted it via
// postCommit — this keeps the backend's epoch bookkeeping (maxEpoch) aligned
// with the real epoch every device's ClientState is actually at (1, since
// createGroup starts at epoch 0 and this one commit advances it), exactly as
// production's ensureGroupReady() does via mlsRepo.postCommit() before
// provisionAllOtherDevices() ever runs. Without this, the first real test
// commit posted afterwards would be rejected as an EPOCH_GAP against an
// empty backend expecting epoch 0.
export async function makeGroup(conversationId: string, backend: FakeMlsBackend, founder: Device, joiners: Device[]): Promise<void> {
  const cs = await getCs();

  const founderCred = { credentialType: 'basic' as const, identity: new TextEncoder().encode(`harness#${founder.device.id}`) };
  const founderKp = await generateKeyPackage(founderCred, defaultCapabilities(), defaultLifetime, [], cs);
  const groupId = new TextEncoder().encode(conversationId);
  const state0 = await createGroup(groupId, founderKp.publicPackage, founderKp.privatePackage, [], cs);

  const joinerKPs: Array<{ publicPackage: unknown; privatePackage: PrivateKeyPackage }> = [];
  for (const joiner of joiners) {
    const cred = { credentialType: 'basic' as const, identity: new TextEncoder().encode(`harness#${joiner.device.id}`) };
    const kp = await generateKeyPackage(cred, defaultCapabilities(), defaultLifetime, [], cs);
    joinerKPs.push(kp);
  }

  const addProposals: ProposalAdd[] = joinerKPs.map(kp => ({ proposalType: 'add', add: { keyPackage: kp.publicPackage as never } }));
  const { newState, welcome, commit } = await createCommit(
    { state: state0, cipherSuite: cs },
    { extraProposals: addProposals, wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  if (!welcome) throw new Error('harness: expected a welcome when adding joiners');

  await backend.postCommit(conversationId, founder.device.id, bytesToBase64(encodeMlsMessage(commit)), 0);

  founder.seedGroupState(conversationId, bytesToBase64(encodeGroupState(newState)));

  for (let i = 0; i < joiners.length; i++) {
    const kp = joinerKPs[i]!;
    const joinedState = await joinGroup(welcome, kp.publicPackage as never, kp.privatePackage, emptyPskIndex, cs);
    joiners[i]!.seedGroupState(conversationId, bytesToBase64(encodeGroupState(joinedState)));
  }
}
