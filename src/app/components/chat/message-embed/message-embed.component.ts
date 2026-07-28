import { Component, Input, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import { EmbedPreferencesService } from '../../../core/embed/embed-preferences.service';
import { EmbedSessionOverrideService } from '../../../core/embed/embed-session-override.service';
import type { EmbedMatch } from '../../../core/embed/embed-provider.types';

@Component({
  selector: 'app-message-embed',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, TranslatePipe],
  templateUrl: './message-embed.component.html',
  styleUrls: ['./message-embed.component.scss'],
})
export class MessageEmbedComponent {
  @Input({ required: true }) match!: EmbedMatch;
  @Input({ required: true }) sourceUrl!: string;

  private registry    = inject(EmbedRegistry);
  private prefsSvc    = inject(EmbedPreferencesService);
  private sessionSvc  = inject(EmbedSessionOverrideService);
  private sanitizer   = inject(DomSanitizer);

  readonly provider = computed(() => this.registry.get(this.match.provider));

  // A provider with no live embed method (e.g. TikTok) never renders,
  // regardless of preference or session override -- and never offers
  // "load once"/"always allow" actions, since there's nothing to load.
  readonly renderMode = computed<'render' | 'disabled-card'>(() => {
    if (!this.provider().embeddable) return 'disabled-card';
    if (this.prefsSvc.isEnabled(this.match.provider)) return 'render';
    if (this.sessionSvc.isLoadedOnce(this.sourceUrl)) return 'render';
    return 'disabled-card';
  });

  readonly showOverrideActions = computed(() => this.provider().embeddable);
  readonly renderKind          = computed(() => this.provider().renderKind);

  readonly safeEmbedUrl = computed<SafeResourceUrl | null>(() => {
    if (this.renderMode() !== 'render' || this.renderKind() !== 'iframe') return null;
    // Reconstructed by Bluvy from a validated, provider-parsed ID -- never
    // taken directly from message text.
    const url = this.provider().buildEmbedUrl(this.match);
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  readonly plainImageUrl = computed<string | null>(() => {
    if (this.renderMode() !== 'render' || this.renderKind() !== 'image') return null;
    return this.provider().buildEmbedUrl(this.match);
  });

  // Session-only: never persisted to the cache or the PDS record.
  loadOnce(): void {
    this.sessionSvc.markLoadedOnce(this.sourceUrl);
  }

  // Persists to the PDS via EmbedPreferencesService -- a distinct code path from loadOnce().
  alwaysAllow(): void {
    void this.prefsSvc.setAlwaysAllow(this.match.provider, true);
  }
}
