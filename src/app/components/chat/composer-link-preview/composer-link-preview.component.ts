import { Component, Input, OnChanges, SimpleChanges, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import { LinkPreviewService } from '../../../core/link-preview/link-preview.service';
import { TranslationService } from '../../../core/i18n/translation.service';
import { extractAllUrls, classifyMessageLink } from '../../../core/message-link/detect-message-link.util';
import type { DetectedMessageLink } from '../../../core/message-link/detect-message-link.util';

const GENERIC_PREVIEW_DEBOUNCE_MS = 400;

export interface ComposerPreviewCard {
  key: string;
  icon: string;
  /** null = neutral/generic style (no provider brand color). */
  accentColor: string | null;
  title: string;
  imageUrl: string | null;
  hostname: string;
  url: string;
}

// Live "what you're about to send" indicator shown above the composer as the
// user types -- one card per link found (same order as in the text),
// deliberately plain link-preview cards only, never the real embed/native
// card: an interactive Bluesky post card here would let its Like/Repost/
// Quote buttons act on the linked post before the user has even sent their
// own message, and a live YouTube/Twitch iframe would be a lot of weight to
// render just to show what's about to be sent.
//
// Every link gets a branded placeholder (provider icon/color, or a generic
// "Bluesky post"/"Popfeed review" label) shown immediately, then a real SEO
// title/thumbnail is fetched in the background and swaps it in if the
// target page actually provides one -- most sites (YouTube, bsky.app post
// pages, ...) do; some (Popfeed's catalog pages) serve no SSR content at
// all, in which case the placeholder is all there is to show.
@Component({
  selector: 'app-composer-link-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon],
  templateUrl: './composer-link-preview.component.html',
  styleUrls: ['./composer-link-preview.component.scss'],
})
export class ComposerLinkPreviewComponent implements OnChanges {
  @Input() text = '';

  private embedRegistry  = inject(EmbedRegistry);
  private linkPreviewSvc = inject(LinkPreviewService);
  private i18n           = inject(TranslationService);

  readonly cards = signal<ComposerPreviewCard[]>([]);

  private lastKey = '';
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['text']) return;

    const extracted = extractAllUrls(this.text);
    const key = extracted.map(e => e.url).join('\n');
    if (key === this.lastKey) return;

    this.lastKey = key;
    if (this.debounceHandle) clearTimeout(this.debounceHandle);

    this.cards.set(extracted.map((e, i) => {
      const hostname = this.hostnameOf(e.url);
      const classified = classifyMessageLink(e.url, this.embedRegistry);
      return this.buildFallbackCard(`${i}-${e.url}`, classified, hostname, e.url);
    }));

    if (extracted.length === 0) return;

    // Only the network fetch is debounced -- avoid hammering the backend on
    // every keystroke while the URL is still being typed/edited.
    this.debounceHandle = setTimeout(() => {
      extracted.forEach((e, i) => this.enrichWithSeoMeta(key, i, e.url, this.hostnameOf(e.url)));
    }, GENERIC_PREVIEW_DEBOUNCE_MS);
  }

  private buildFallbackCard(key: string, classified: DetectedMessageLink, hostname: string, url: string): ComposerPreviewCard {
    switch (classified.kind) {
      case 'bskyPost':
        return { key, icon: 'link-outline', accentColor: null, title: this.i18n.t('composerPreview.bskyPost'), imageUrl: null, hostname, url };
      case 'popfeedReview':
        return { key, icon: 'link-outline', accentColor: null, title: this.i18n.t('composerPreview.popfeedReview'), imageUrl: null, hostname, url };
      case 'embed': {
        const provider = this.embedRegistry.get(classified.match.provider);
        return { key, icon: provider.icon, accentColor: provider.accentColor, title: provider.label, imageUrl: null, hostname, url };
      }
      case 'generic':
        return { key, icon: 'link-outline', accentColor: null, title: hostname, imageUrl: null, hostname, url };
    }
  }

  private enrichWithSeoMeta(key: string, index: number, url: string, hostname: string): void {
    void this.linkPreviewSvc.getPreview(url).then(meta => {
      // Keep whichever branded/fallback card is already showing if the
      // target page has no real title to offer.
      if (this.lastKey !== key || !meta?.title) return;

      this.cards.update(arr => arr.map((c, i) => i === index
        ? { ...c, icon: 'link-outline', accentColor: null, title: meta.title! }
        : c));

      if (meta.imageUrl) {
        void this.linkPreviewSvc.getImageObjectUrl(meta.imageUrl).then(src => {
          if (this.lastKey === key) {
            this.cards.update(arr => arr.map((c, i) => i === index ? { ...c, imageUrl: src } : c));
          }
        });
      }
    });
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }
}
