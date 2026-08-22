import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { TranslatePipe } from '@ngx-translate/core';

import type { BskyQuoteTarget } from '../../../core/bsky-post/bsky-post.types';

@Component({
  selector: 'app-bsky-quote-embed',
  imports: [IonIcon, AvatarComponent, TranslatePipe],
  templateUrl: './bsky-quote-embed.component.html',
  styleUrls: ['./bsky-quote-embed.component.scss'],
})
export class BskyQuoteEmbedComponent {
  readonly target = input.required<BskyQuoteTarget>();
}
