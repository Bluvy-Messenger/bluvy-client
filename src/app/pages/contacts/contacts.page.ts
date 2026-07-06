import { Component, ViewChild, inject } from '@angular/core';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonRefresher, IonRefresherContent,
} from '@ionic/angular/standalone';
import { SidebarListComponent } from '../../components/chat/sidebar-list/sidebar-list.component';
import { WelcomeComponent } from '../../components/ui/welcome/welcome.component';
import { BreakpointService } from '../../core/layout/breakpoint.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';

@Component({
  selector: 'app-contacts',
  templateUrl: './contacts.page.html',
  styleUrls: ['./contacts.page.scss'],
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonRefresher, IonRefresherContent,
    SidebarListComponent,
    WelcomeComponent,
    TranslatePipe,
  ],
})
export class ContactsPage {
  readonly bpSvc = inject(BreakpointService);

  @ViewChild(SidebarListComponent) sidebarList!: SidebarListComponent;

  async handleRefresh(event: CustomEvent): Promise<void> {
    if (this.sidebarList) {
      await this.sidebarList.loadContacts();
    }
    (event.target as HTMLIonRefresherElement).complete();
  }
}
