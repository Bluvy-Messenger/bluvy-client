import { Injectable, inject, signal } from '@angular/core';
import { SocketService } from './socket.service';

@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private socketSvc = inject(SocketService);

  readonly online = signal(navigator.onLine);

  constructor() {
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));

    // A socket connect error usually means the device has network but can't
    // reach the server — treat it the same as offline for the banner. The
    // exception is UNAUTHORIZED: that's a recoverable, token-not-ready-yet
    // race (AuthService.startSocket() already refreshes and reconnects for
    // this exact case), not a real connectivity problem.
    this.socketSvc.connectError$.subscribe(err => {
      if (err.message === 'UNAUTHORIZED') return;
      this.online.set(false);
    });
    this.socketSvc.reconnect$.subscribe(() => this.online.set(true));
  }
}
