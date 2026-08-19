import { Component, input, signal, inject, effect } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import { LinkPreviewService } from '../../../core/link-preview/link-preview.service';
import { TranslationService } from '../../../core/i18n/translation.service';
import { extractAllUrls, classifyMessageLink, type DetectedMessageLink, type ExtractedUrl } from '../../../core/message-link/detect-message-link.util';

export interface ComposerPreviewCard {
  key: string;
  icon: string;
  accentColor: string | null;
  title: string;
  imageUrl: string | null;
  hostname: string;
  url: string;
}

const GENERIC_PREVIEW_DEBOUNCE_MS = 400;

@Component({
  selector: 'app-composer-link-preview',
  imports: [IonIcon],
  templateUrl: './composer-link-preview.component.html',
  styleUrls: ['./composer-link-preview.component.scss'],
})
export class ComposerLinkPreviewComponent {
  readonly text = input<string>('');

  private embedRegistry  = inject(EmbedRegistry);
  private linkPreviewSvc = inject(LinkPreviewService);
  private i18n           = inject(TranslationService);

  readonly cards = signal<ComposerPreviewCard[]>([]);

  private lastKey: string | undefined = undefined;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const currentText = this.text();
      const extracted = extractAllUrls(currentText);
      const key = extracted.map((e: ExtractedUrl) => e.url).join('\n');
      if (key === this.lastKey) return;

      this.lastKey = key;
      if (this.debounceHandle) clearTimeout(this.debounceHandle);

      this.cards.set(extracted.map((e: ExtractedUrl, i: number) => {
        const hostname = this.hostnameOf(e.url);
        const classified = classifyMessageLink(e.url, this.embedRegistry);
        return this.buildFallbackCard(`${i}-${e.url}`, classified, hostname, e.url);
      }));

      if (extracted.length === 0) return;

      this.debounceHandle = setTimeout(() => {
        extracted.forEach((e: ExtractedUrl, i: number) => this.enrichWithSeoMeta(key, i, e.url, this.hostnameOf(e.url)));
      }, GENERIC_PREVIEW_DEBOUNCE_MS);
    });
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
