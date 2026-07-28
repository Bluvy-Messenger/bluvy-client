import { Component, Input, OnChanges, SimpleChanges, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';
import { LinkPreviewService } from '../../../core/link-preview/link-preview.service';
import type { LinkPreviewMeta } from '../../../core/link-preview/link-preview.types';
import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import type { EmbedMatch } from '../../../core/embed/embed-provider.types';
import { MessageEmbedComponent } from '../message-embed/message-embed.component';

interface DetectedEmbed {
  match: EmbedMatch;
  url: string;
}

// First http(s) URL in the text, trimmed of trailing sentence punctuation
// (e.g. "check this out: https://example.com." shouldn't include the period).
const URL_REGEX = /https?:\/\/\S+/i;
const TRAILING_PUNCTUATION = /[)\].,!?'"]+$/;

@Component({
  selector: 'app-message-bubble',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, IonIcon, MessageEmbedComponent],
  templateUrl: './message-bubble.component.html',
  styleUrls: ['./message-bubble.component.scss'],
})
export class MessageBubbleComponent implements OnChanges {
  @Input() text = '';
  @Input() isMine = false;
  @Input() timestamp = 0;
  @Input() pending = false;
  @Input() position: 'first' | 'middle' | 'last' | 'single' = 'single';
  @Input() receiptStatus: 'read' | 'delivered' | 'sent' | null = null;

  private linkPreviewSvc = inject(LinkPreviewService);
  private embedRegistry  = inject(EmbedRegistry);

  preview         = signal<LinkPreviewMeta | null>(null);
  previewImageSrc = signal<string | null>(null);
  embed           = signal<DetectedEmbed | null>(null);
  // Full text until a preview actually resolves — only then is the raw URL
  // stripped, so there's no flash of text disappearing before the card is
  // confirmed available.
  displayText     = signal('');

  private lastDetectedUrl: string | null = null;
  private lastRawMatch: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['text']) return;

    this.displayText.set(this.text);

    const match = URL_REGEX.exec(this.text);
    const rawMatch = match ? match[0] : null;
    const url = rawMatch ? rawMatch.replace(TRAILING_PUNCTUATION, '') : null;
    if (url === this.lastDetectedUrl) return;

    this.lastDetectedUrl = url;
    this.lastRawMatch = rawMatch;
    this.preview.set(null);
    this.previewImageSrc.set(null);
    this.embed.set(null);
    if (!url) return;

    // Provider-matched URLs (YouTube, Spotify, ...) get their own rich embed
    // instead of the generic OG-scraped preview card -- never both.
    const embedMatch = this.embedRegistry.detect(url);
    if (embedMatch) {
      this.embed.set({ match: embedMatch, url });
      if (rawMatch) {
        this.displayText.set(this.text.replace(rawMatch, '').trim());
      }
      return;
    }

    void this.linkPreviewSvc.getPreview(url).then(meta => {
      if (this.lastDetectedUrl !== url || !meta || meta.status !== 'ok' || !meta.title) return;
      this.preview.set(meta);
      if (rawMatch) {
        this.displayText.set(this.text.replace(rawMatch, '').trim());
      }

      if (meta.imageUrl) {
        void this.linkPreviewSvc.getImageObjectUrl(meta.imageUrl).then(src => {
          if (this.lastDetectedUrl === url) this.previewImageSrc.set(src);
        });
      }
    });
  }

  // Fallback domain label for cards whose page never declared og:site_name.
  hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}
