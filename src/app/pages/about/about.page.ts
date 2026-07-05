import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-about',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './about.page.html',
  styleUrls: ['./about.page.scss'],
})
export class AboutPage {
  private location = inject(Location);
  private router   = inject(Router);

  readonly version = environment.version;

  @Input()  embedded     = false;
  @Output() navigateBack = new EventEmitter<void>();

  goBack(): void {
    if (this.embedded) { this.navigateBack.emit(); return; }
    this.location.back();
  }

  navigate(path: string): void { void this.router.navigate([path]); }
}
