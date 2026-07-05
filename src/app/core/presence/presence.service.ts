import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { SocketService } from '../infrastructure/socket.service';
import type { PresenceStatus } from '../infrastructure/socket.types';

export type { PresenceStatus } from '../infrastructure/socket.types';

@Injectable({ providedIn: 'root' })
export class PresenceService implements OnDestroy {
  private readonly socketSvc = inject(SocketService);
  private readonly statusMap  = new Map<string, BehaviorSubject<PresenceStatus>>();
  private readonly MAX_TRACKED = 500;
  private readonly sub       = new Subscription();

  constructor() {
    this.sub.add(
      this.socketSvc.presenceSnapshot$.subscribe(({ statuses }) => {
        for (const { did, status } of statuses) {
          this.getSubject(did).next(status);
        }
      }),
    );
    this.sub.add(
      this.socketSvc.presenceUpdate$.subscribe(({ did, status }) => {
        this.getSubject(did).next(status);
      }),
    );
  }

  status$(did: string): Observable<PresenceStatus> {
    return this.getSubject(did).asObservable();
  }

  status(did: string): PresenceStatus {
    return this.statusMap.get(did)?.getValue() ?? 'offline';
  }

  private getSubject(did: string): BehaviorSubject<PresenceStatus> {
    let subject = this.statusMap.get(did);
    if (!subject) {
      if (this.statusMap.size >= this.MAX_TRACKED) {
        const firstKey = this.statusMap.keys().next().value as string | undefined;
        if (firstKey !== undefined) this.statusMap.delete(firstKey);
      }
      subject = new BehaviorSubject<PresenceStatus>('offline');
      this.statusMap.set(did, subject);
    }
    return subject;
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
