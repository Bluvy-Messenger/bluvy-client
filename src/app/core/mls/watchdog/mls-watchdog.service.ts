import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { ConversationMlsState } from '../coordinator/mls-coordinator.types';
import { environment } from '../../../../environments/environment';

export interface MlsStuckStateEvent {
  readonly conversationId: string;
  readonly state:          ConversationMlsState;
  readonly detectedAt:     number;
}

// Timeouts for transitional states in milliseconds.
const STUCK_TIMEOUTS: Partial<Record<ConversationMlsState, number>> = {
  [ConversationMlsState.Joining]:        30_000,
  [ConversationMlsState.Initializing]:   45_000,
  [ConversationMlsState.ApplyingCommit]: 15_000,
};

@Injectable({ providedIn: 'root' })
export class MlsWatchdogService {
  private readonly ngZone = inject(NgZone);

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly stuckState$ = new Subject<MlsStuckStateEvent>();

  // Call whenever a conversation transitions to a new state.
  // Starts a stuck-detection timer for transitional states.
  // Cancels any existing timer for the same convId first.
  watch(convId: string, state: ConversationMlsState): void {
    this.unwatch(convId);

    const timeout = STUCK_TIMEOUTS[state];
    if (timeout === undefined) return; // READY, FAILED, EMPTY — no stuck risk

    this.ngZone.runOutsideAngular(() => {
      const timer = setTimeout(() => {
        if (!environment.production) console.error(
          `[MLS:watchdog] Stuck state detected — convId=${convId} state=${state}`,
          `(no transition after ${timeout / 1000}s)`,
        );
        this.stuckState$.next({ conversationId: convId, state, detectedAt: Date.now() });
      }, timeout);
      this.timers.set(convId, timer);
    });
  }

  // Call when a conversation leaves a transitional state or is destroyed.
  unwatch(convId: string): void {
    const timer = this.timers.get(convId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(convId);
    }
  }
}
