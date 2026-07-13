import { Component, ViewChild, inject } from '@angular/core';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonRefresher, IonRefresherContent,
  IonButtons, IonButton, IonIcon,
} from '@ionic/angular/standalone';
import { SidebarListComponent } from '../../components/chat/sidebar-list/sidebar-list.component';
import { WelcomeComponent } from '../../components/ui/welcome/welcome.component';
import { BreakpointService } from '../../core/layout/breakpoint.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { NavigationRedirectService } from '../../core/auth/navigation-redirect.service';
import { AuthService } from '../../core/auth/auth.service';
import { KeyPackageService } from '../../core/mls/key-package/key-package.service';

@Component({
  selector: 'app-conversations',
  templateUrl: './conversations.page.html',
  styleUrls: ['./conversations.page.scss'],
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonRefresher, IonRefresherContent,
    IonButtons, IonButton, IonIcon,
    SidebarListComponent,
    WelcomeComponent,
    TranslatePipe,
  ],
})
export class ConversationsPage {
  readonly bpSvc       = inject(BreakpointService);
  private readonly redirectSvc = inject(NavigationRedirectService);
  private readonly authSvc     = inject(AuthService);
  private readonly kpSvc       = inject(KeyPackageService);

  @ViewChild(SidebarListComponent) sidebarList!: SidebarListComponent;

  ionViewWillEnter(): void {
    const user = this.authSvc.currentUser();
    if (user) {
      // Verify and sync ATProto declaration record
      const device = this.authSvc.currentDevice();
      if (device) {
        void this.kpSvc.syncDeclaration(user.did, device.id);
      }

      // Process pending invitation deep links
      void this.redirectSvc.processPendingInvite(user.did);
    }
  }

  async handleRefresh(event: CustomEvent): Promise<void> {
    if (this.sidebarList) {
      await this.sidebarList.load();
    }
    (event.target as HTMLIonRefresherElement).complete();
  }
}
