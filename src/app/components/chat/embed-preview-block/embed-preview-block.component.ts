import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
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

// Shared rendering for the four mutually-exclusive link-preview kinds
// (native Bluesky post / native Popfeed review / provider embed / generic
// OG-scraped preview), used both by a sent message bubble and by the live
// pre-send preview above the composer -- one definition, two callers.
@Component({
  selector: 'app-embed-preview-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, MessageEmbedComponent, BskyPostCardComponent, PopfeedReviewCardComponent],
  templateUrl: './embed-preview-block.component.html',
  styleUrls: ['./embed-preview-block.component.scss'],
  // Exposes the embed's provider on this component's own host element so
  // message-bubble.component.scss can target app-embed-preview-block
  // directly (its real direct child) for the GIF full-bleed treatment --
  // app-message-embed itself is nested one level too deep for that
  // stylesheet to reach under Angular's emulated view encapsulation.
  host: {
    '[class.embed-preview-block--mine]': 'isMine',
    '[attr.data-provider]': 'embed?.match?.provider ?? null',
  },
})
export class EmbedPreviewBlockComponent {
  @Input() bskyPostUrl: string | null = null;
  @Input() popfeedReviewUrl: string | null = null;
  @Input() embed: EmbedPreviewEmbed | null = null;
  @Input() preview: LinkPreviewMeta | null = null;
  @Input() previewImageSrc: string | null = null;
  @Input() isMine = false;

  // Fallback domain label for cards whose page never declared og:site_name.
  hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}
