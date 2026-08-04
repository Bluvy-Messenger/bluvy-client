import { MlsStateStorageService } from './mls-state-storage.service';

// Regression coverage for forensic audit finding F1 / R3: MlsStateStorageService
// used to offer no signal at all when a same-scope nested update() call
// deadlocked the per-scope lock (see mls.service.ts's
// removeRevokedDeviceFromAllGroups fix). A blanket "second concurrent call for
// this scope throws" guard was considered and rejected: this service
// deliberately allows multiple *unrelated* callers to queue concurrent
// update() calls for the same scope (e.g. an incoming commit for one
// conversation and an outgoing message for another share the same per-device
// scope) -- JS's single-threaded async model gives no reliable way to tell
// that apart from true nesting once an await has occurred in between, so a
// synchronous reentrancy check would misfire on ordinary, correct concurrent
// use. Instead, update() schedules a watchdog timer that logs loudly (with
// the call site) if a call hasn't completed within the threshold, without
// ever throwing or altering the lock's behavior.
describe('MlsStateStorageService — stuck-lock watchdog (F1 / R3)', () => {
  let service: MlsStateStorageService;

  beforeEach(() => {
    service = new MlsStateStorageService();
  });

  it('schedules a 10s watchdog and logs loudly, naming the scope, if it fires before the update() call completes', async () => {
    const scope = 'mls:did:plc:watchdog-test:device-1';
    let capturedCallback: (() => void) | undefined;
    let capturedDelay: number | undefined;
    spyOn(window, 'setTimeout').and.callFake(((cb: () => void, delay?: number) => {
      capturedCallback = cb;
      capturedDelay = delay;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimeoutSpy = spyOn(window, 'clearTimeout');
    const consoleErrorSpy = spyOn(console, 'error');

    let resolveUpdater!: (value: null) => void;
    const stuck = new Promise<null>(resolve => { resolveUpdater = resolve; });

    const updatePromise = service.update<null>(scope, async () => stuck);

    // setTimeout() is scheduled synchronously at call time, before load()/the
    // lock queue even run -- no need to await anything first.
    expect(capturedDelay).toBe(10_000);

    capturedCallback?.();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const [message] = consoleErrorSpy.calls.mostRecent().args as [string];
    expect(message).toContain(scope);
    expect(message).toContain('deadlocked');

    resolveUpdater(null);
    await updatePromise;
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('does not log anything when update() completes normally', async () => {
    const scope = 'mls:did:plc:watchdog-test:device-2';
    const consoleErrorSpy = spyOn(console, 'error');

    await service.update<null>(scope, async () => null);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // Proves the watchdog design doesn't reintroduce the false-positive risk a
  // naive reentrancy guard would have: two unrelated callers legitimately
  // queueing behind each other for the same scope must not trigger anything.
  it('does not misfire when two unrelated calls for the same scope legitimately queue behind each other', async () => {
    const scope = 'mls:did:plc:watchdog-test:device-3';
    const consoleErrorSpy = spyOn(console, 'error');

    let resolveFirst!: (value: null) => void;
    const first = new Promise<null>(resolve => { resolveFirst = resolve; });

    const firstUpdate  = service.update<null>(scope, async () => first);
    const secondUpdate = service.update<null>(scope, async () => null); // unrelated caller, just queues

    resolveFirst(null);
    await Promise.all([firstUpdate, secondUpdate]);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
