import { Component, OnInit, inject } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { SeoService } from '../../core/services/seo.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';

@Component({
  selector: 'app-terms',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './terms.page.html',
  styleUrls: ['./legal.scss'],
})
export class TermsPage implements OnInit {
  private location = inject(Location);
  private seo      = inject(SeoService);
  protected i18n   = inject(TranslationService);

  ngOnInit(): void {
    this.seo.set({
      title:         'Conditions d\'utilisation',
      description:   'Conditions Générales d\'Utilisation de Bluvy Messenger, messagerie privée chiffrée E2E basée sur votre identité Bluesky.',
      canonicalPath: '/terms',
    });
  }

  goBack(): void { this.location.back(); }
}
