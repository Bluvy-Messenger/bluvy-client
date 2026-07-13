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
    // reach the server — treat it the same as offline for the banner.
    this.socketSvc.connectError$.subscribe(() => this.online.set(false));
    this.socketSvc.reconnect$.subscribe(() => this.online.set(true));
  }
}
