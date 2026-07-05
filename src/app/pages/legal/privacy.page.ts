import { Component, OnInit, inject } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { SeoService } from '../../core/services/seo.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';

@Component({
  selector: 'app-privacy',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './privacy.page.html',
  styleUrls: ['./legal.scss'],
})
export class PrivacyPage implements OnInit {
  private location = inject(Location);
  private seo      = inject(SeoService);
  protected i18n   = inject(TranslationService);

  ngOnInit(): void {
    this.seo.set({
      title:         'Politique de confidentialité',
      description:   'Vos messages sont chiffrés sur votre appareil — Bluvy Messenger ne peut pas lire leur contenu. Informations sur la collecte et le traitement des données.',
      canonicalPath: '/privacy',
    });
  }

  goBack(): void { this.location.back(); }
}
