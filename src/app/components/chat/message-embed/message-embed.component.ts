import { Component, input, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '@ngx-translate/core';

import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import { EmbedPreferencesService } from '../../../core/embed/embed-preferences.service';
import { EmbedSessionOverrideService } from '../../../core/embed/embed-session-override.service';
import { LinkPreviewService } from '../../../core/link-preview/link-preview.service';
import type { EmbedMatch } from '../../../core/embed/embed-provider.types';

@Component({
  selector: 'app-message-embed',
  imports: [IonIcon, TranslatePipe],
  templateUrl: './message-embed.component.html',
  styleUrls: ['./message-embed.component.scss'],
  host: {
    '[attr.data-provider]': 'match().provider',
    '[class.msg-embed--mine]': 'isMine()',
  },
})
export class MessageEmbedComponent implements OnInit {
  readonly match = input.required<EmbedMatch>();
  readonly sourceUrl = input.required<string>();
  readonly isMine = input<boolean>(false);

  private registry       = inject(EmbedRegistry);
  private prefsSvc       = inject(EmbedPreferencesService);
  private sessionSvc     = inject(EmbedSessionOverrideService);
  private sanitizer      = inject(DomSanitizer);
  private linkPreviewSvc = inject(LinkPreviewService);

  readonly previewTitle     = signal<string | null>(null);
  readonly previewImageSrc  = signal<string | null>(null);

  readonly provider = computed(() => this.registry.get(this.match().provider));

  readonly renderMode = computed<'render' | 'disabled-card'>(() => {
    if (!this.provider().embeddable) return 'disabled-card';
    if (this.prefsSvc.isEnabled(this.match().provider)) return 'render';
    if (this.sessionSvc.isLoadedOnce(this.sourceUrl())) return 'render';
    return 'disabled-card';
  });

  readonly showOverrideActions = computed(() => this.provider().embeddable);

  ngOnInit(): void {
    if (this.renderMode() !== 'disabled-card') return;

    void this.linkPreviewSvc.getPreview(this.sourceUrl()).then(meta => {
      if (!meta || meta.status !== 'ok') return;
      if (meta.title) this.previewTitle.set(meta.title);
      if (meta.imageUrl) {
        void this.linkPreviewSvc.getImageObjectUrl(meta.imageUrl).then(src => this.previewImageSrc.set(src));
      }
    });
  }

  readonly safeEmbedUrl = computed<SafeResourceUrl | null>(() => {
    if (this.renderMode() !== 'render') return null;
    const url = this.provider().buildEmbedUrl(this.match());
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  loadOnce(): void {
    this.sessionSvc.markLoadedOnce(this.sourceUrl());
  }

  alwaysAllow(): void {
    void this.prefsSvc.setAlwaysAllow(this.match().provider, true);
  }
}
