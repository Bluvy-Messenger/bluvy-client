import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MlsRepository } from '../mls/mls.repository';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { AuthService } from './auth.service';
import { ROUTES } from '../routes';

export interface InviteContext {
  targetDid: string;
  viewerDid: string | null;
}

@Injectable({ providedIn: 'root' })
export class NavigationRedirectService {
  private readonly router      = inject(Router);
  private readonly mlsRepo     = inject(MlsRepository);
  private readonly coordinator = inject(MlsCoordinatorBase);
  private readonly authSvc     = inject(AuthService);

  constructor() {
    this.captureHashContext();
  }

  /**
   * Captures the target DID context from the URL fragment (hash) and stores it in sessionStorage,
   * then clears the hash from the browser address bar.
   */
  captureHashContext(): void {
    if (typeof window === 'undefined') return;
    
    // Hash could contain incoming DIDs: #did:plc:123+did:plc:456 or just #did:plc:123
    const hash = window.location.hash;
    if (!hash) return;

    const match = hash.match(/^#(did:[a-z0-9\.\-:]+)(?:\+(did:[a-z0-9\.\-:]+))?$/i);
    if (match) {
      const targetDid = match[1]!;
      const viewerDid = match[2] || null;

      sessionStorage.setItem('bluvy_invite_context', JSON.stringify({ targetDid, viewerDid }));

      // Clean the address bar to avoid keeping the hash visible
      window.location.hash = '';
      window.history.replaceState(null, '', window.location.pathname);
    }
  }

  /**
   * Checks sessionStorage for any pending invite context. If found and validated,
   * it executes the discovery process, sets up MLS context if needed, and navigates
   * to the conversation.
   */
  async processPendingInvite(loggedInUserDid: string): Promise<boolean> {
    const cached = sessionStorage.getItem('bluvy_invite_context');
    if (!cached) return false;

    let context: InviteContext;
    try {
      context = JSON.parse(cached) as InviteContext;
    } catch {
      sessionStorage.removeItem('bluvy_invite_context');
      return false;
    }

    // If a viewerDid was specified, ensure it matches the currently logged-in user
    if (context.viewerDid && context.viewerDid !== loggedInUserDid) {
      sessionStorage.removeItem('bluvy_invite_context');
      return false;
    }

    try {
      // 1. Run Discovery on the backend
      const result = await this.mlsRepo.discover(context.targetDid);
      const conversationId = result.conversation.id;

      // 2. If we got a KeyPackage, we need to initialize the MLS group locally as the initiator
      if (result.keyPackage) {
        const user = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (user && device) {
          await this.coordinator.prepareConversationWithKeyPackage(
            user,
            device,
            context.targetDid,
            conversationId,
            result.keyPackage
          );
        }
      }

      // Only clear the pending invite once it has been fully processed.
      sessionStorage.removeItem('bluvy_invite_context');

      // 3. Navigate straight to the conversation page
      void this.router.navigate([ROUTES.conversation(conversationId)]);
      return true;
    } catch {
      // Leave the context in place so the next attempt (e.g. re-entering
      // the conversations tab) can retry instead of losing the invite.
    }

    return false;
  }
}
