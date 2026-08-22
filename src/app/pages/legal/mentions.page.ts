import { Component, OnInit, inject } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { SeoService } from '../../core/services/seo.service';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';



@Component({
  selector: 'app-mentions',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './mentions.page.html',
  styleUrls: ['./legal.scss'],
})
export class MentionsPage implements OnInit {
  private location = inject(Location);
  private seo      = inject(SeoService);
  protected i18n   = inject(TranslateService);

  ngOnInit(): void {
    this.seo.set({
      title:         'Mentions légales',
      description:   'Mentions légales de Bluvy Messenger — éditeur Thomasfds Apps, hébergement européen, propriété intellectuelle (LCEN).',
      canonicalPath: '/mentions',
    });
  }

  goBack(): void { this.location.back(); }
}
