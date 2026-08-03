import { Component, Input, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { IonIcon, IonModal, ActionSheetController } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { BskyQuoteEmbedComponent } from '../bsky-quote-embed/bsky-quote-embed.component';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { BskyPostRepository } from '../../../core/bsky-post/bsky-post.repository';
import { AtprotoRepoService } from '../../../core/auth/atproto-repo.service';
import { parseBskyPostUrl } from '../../../core/bsky-post/bsky-post-url.util';
import type { BskyPostView } from '../../../core/bsky-post/bsky-post.types';

@Component({
  selector: 'app-bsky-post-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, IonIcon, IonModal, AvatarComponent, BskyQuoteEmbedComponent, TranslatePipe],
  templateUrl: './bsky-post-card.component.html',
  styleUrls: ['./bsky-post-card.component.scss'],
  // Emulated view encapsulation scopes selectors to this component's own
  // template, so a bare `.bubble--mine &` reaching into the parent bubble's
  // class never matches (the exact bug already fixed in message-embed).
  host: { '[class.bsky-post--mine]': 'isMine' },
})
export class BskyPostCardComponent implements OnInit {
  @Input({ required: true }) sourceUrl!: string;
  @Input() isMine = false;
  // Used when nesting this card inside another provider's own rich card
  // (e.g. a Popfeed review that already shows the same title/text via its
  // Bluesky cross-post) -- shows only the counts + like/quote/open actions,
  // never the avatar/text/embed, so content isn't duplicated.
  @Input() compact = false;

  private postRepo       = inject(BskyPostRepository);
  private atprotoSvc     = inject(AtprotoRepoService);
  private actionSheetCtrl = inject(ActionSheetController);
  private i18n            = inject(TranslationService);

  readonly state = signal<'loading' | 'loaded' | 'error'>('loading');
  readonly post  = signal<BskyPostView | null>(null);

  // Optimistic like/repost toggles -- flipped immediately, rolled back on failure.
  readonly liked       = signal(false);
  readonly likeCount   = signal(0);
  readonly likeUri     = signal<string | null>(null);
  readonly likePending = signal(false);

  readonly reposted       = signal(false);
  readonly repostCount    = signal(0);
  readonly repostUri      = signal<string | null>(null);
  readonly repostPending  = signal(false);

  readonly composerOpen       = signal(false);
  readonly composerText       = signal('');
  readonly composerSubmitting = signal(false);
  readonly composerError      = signal<string | null>(null);

  readonly quoteCount = computed(() => this.post()?.quoteCount ?? 0);

  async ngOnInit(): Promise<void> {
    const match = parseBskyPostUrl(this.sourceUrl);
    if (!match) {
      this.state.set('error');
      return;
    }

    const post = await this.postRepo.getPost(match);
    if (!post) {
      this.state.set('error');
      return;
    }

    this.post.set(post);
    this.liked.set(!!post.viewerLikeUri);
    this.likeCount.set(post.likeCount);
    this.likeUri.set(post.viewerLikeUri);
    this.reposted.set(!!post.viewerRepostUri);
    this.repostCount.set(post.repostCount);
    this.repostUri.set(post.viewerRepostUri);
    this.state.set('loaded');
  }

  async toggleLike(): Promise<void> {
    const post = this.post();
    if (!post || this.likePending()) return;

    const wasLiked = this.liked();
    const prevUri = this.likeUri();

    // Optimistic flip first.
    this.liked.set(!wasLiked);
    this.likeCount.update(c => c + (wasLiked ? -1 : 1));
    this.likePending.set(true);

    try {
      if (wasLiked && prevUri) {
        await this.atprotoSvc.unlikePost(prevUri);
        this.likeUri.set(null);
      } else if (!wasLiked) {
        const uri = await this.atprotoSvc.likePost(post.uri, post.cid);
        this.likeUri.set(uri);
      }
    } catch {
      // Roll back on failure.
      this.liked.set(wasLiked);
      this.likeCount.update(c => c + (wasLiked ? 1 : -1));
      this.likeUri.set(prevUri);
    } finally {
      this.likePending.set(false);
    }
  }

  async toggleRepost(): Promise<void> {
    const post = this.post();
    if (!post || this.repostPending()) return;

    const wasReposted = this.reposted();
    const prevUri = this.repostUri();

    this.reposted.set(!wasReposted);
    this.repostCount.update(c => c + (wasReposted ? -1 : 1));
    this.repostPending.set(true);

    try {
      if (wasReposted && prevUri) {
        await this.atprotoSvc.unrepostPost(prevUri);
        this.repostUri.set(null);
      } else if (!wasReposted) {
        const uri = await this.atprotoSvc.repostPost(post.uri, post.cid);
        this.repostUri.set(uri);
      }
    } catch {
      this.reposted.set(wasReposted);
      this.repostCount.update(c => c + (wasReposted ? 1 : -1));
      this.repostUri.set(prevUri);
    } finally {
      this.repostPending.set(false);
    }
  }

  // Single "Quote" footer button -- reveals the Repost/Quote-post choice,
  // mirroring Bluesky's own repost-icon menu.
  async onQuoteButtonTap(): Promise<void> {
    const sheet = await this.actionSheetCtrl.create({
      buttons: [
        {
          text: this.i18n.t(this.reposted() ? 'bskyPost.action.unrepost' : 'bskyPost.action.repost'),
          icon: this.reposted() ? 'repeat' : 'repeat-outline',
          handler: () => void this.toggleRepost(),
        },
        {
          text: this.i18n.t('bskyPost.action.quote'),
          icon: 'chatbubble-ellipses-outline',
          handler: () => this.openComposer(),
        },
        {
          text: this.i18n.t('common.cancel'),
          role: 'cancel',
        },
      ],
    });
    await sheet.present();
  }

  private openComposer(): void {
    this.composerOpen.set(true);
    this.composerError.set(null);
  }

  onComposerInput(event: Event): void {
    this.composerText.set((event.target as HTMLTextAreaElement).value);
  }

  cancelComposer(): void {
    this.composerOpen.set(false);
    this.composerText.set('');
    this.composerError.set(null);
  }

  async submitQuote(): Promise<void> {
    const post = this.post();
    if (!post || this.composerSubmitting()) return;

    this.composerSubmitting.set(true);
    this.composerError.set(null);
    try {
      await this.atprotoSvc.quotePost(this.composerText().trim(), { uri: post.uri, cid: post.cid });
      this.post.update(p => p && { ...p, quoteCount: p.quoteCount + 1 });
      this.composerOpen.set(false);
      this.composerText.set('');
    } catch {
      this.composerError.set('bskyPost.composer.error');
    } finally {
      this.composerSubmitting.set(false);
    }
  }

  openExternal(): void {
    window.open(this.sourceUrl, '_blank', 'noopener,noreferrer');
  }
}
