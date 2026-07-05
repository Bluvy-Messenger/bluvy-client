import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class BreakpointService {
  readonly isTablet = signal(window.innerWidth >= 768);

  constructor() {
    window.addEventListener('resize', () =>
      this.isTablet.set(window.innerWidth >= 768));
  }
}
