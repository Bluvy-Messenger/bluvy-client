import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { MessageEmbedComponent } from '../message-embed/message-embed.component';
import { BskyPostCardComponent } from '../bsky-post-card/bsky-post-card.component';
import { PopfeedReviewCardComponent } from '../popfeed-review-card/popfeed-review-card.component';
import type { EmbedMatch } from '../../../core/embed/embed-provider.types';
import type { LinkPreviewMeta } from '../../../core/link-preview/link-preview.types';

export interface EmbedPreviewEmbed {
  match: EmbedMatch;
  url: string;
}

@Component({
  selector: 'app-embed-preview-block',
  imports: [IonIcon, MessageEmbedComponent, BskyPostCardComponent, PopfeedReviewCardComponent],
  templateUrl: './embed-preview-block.component.html',
  styleUrls: ['./embed-preview-block.component.scss'],
  host: {
    '[class.embed-preview-block--mine]': 'isMine()',
    '[attr.data-provider]': 'embed()?.match?.provider ?? null',
  },
})
export class EmbedPreviewBlockComponent {
  readonly bskyPostUrl = input<string | null>(null);
  readonly popfeedReviewUrl = input<string | null>(null);
  readonly embed = input<EmbedPreviewEmbed | null>(null);
  readonly preview = input<LinkPreviewMeta | null>(null);
  readonly previewImageSrc = input<string | null>(null);
  readonly isMine = input<boolean>(false);

  hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}
