import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import type { BskyQuoteTarget } from '../../../core/bsky-post/bsky-post.types';

@Component({
  selector: 'app-bsky-quote-embed',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, AvatarComponent, TranslatePipe],
  templateUrl: './bsky-quote-embed.component.html',
  styleUrls: ['./bsky-quote-embed.component.scss'],
})
export class BskyQuoteEmbedComponent {
  @Input({ required: true }) target!: BskyQuoteTarget;
}
