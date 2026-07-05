// Per-conversation promise barrier that blocks crypto operations while a
// Welcome or group initialization is in progress for that conversation.
//
// register() must be called synchronously (before any await) in processWelcome()
// so that concurrent decryptMessage() calls immediately see the barrier and wait.
export class InitializationBarrier {
  private readonly barriers = new Map<string, Promise<void>>();

  // Returns { promise, release }. The caller holds the barrier until release() is called.
  // If a barrier is already registered for convId, the new one chains after it.
  register(convId: string): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });

    const prev    = this.barriers.get(convId);
    const chained = prev ? prev.then(() => promise) : promise;

    this.barriers.set(convId, chained);

    void chained.finally(() => {
      if (this.barriers.get(convId) === chained) {
        this.barriers.delete(convId);
      }
    });

    return { promise, release };
  }

  // Resolves immediately if no barrier is active for convId.
  async wait(convId: string): Promise<void> {
    const barrier = this.barriers.get(convId);
    if (barrier) await barrier;
  }

  isInitializing(convId: string): boolean {
    return this.barriers.has(convId);
  }
}
