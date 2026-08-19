import { Component, input, OnInit, inject, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { BskyPostCardComponent } from '../bsky-post-card/bsky-post-card.component';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { PopfeedReviewRepository } from '../../../core/popfeed-review/popfeed-review.repository';
import { parsePopfeedReviewUrl } from '../../../core/popfeed-review/popfeed-review-url.util';
import type { PopfeedReviewView } from '../../../core/popfeed-review/popfeed-review.types';

@Component({
  selector: 'app-popfeed-review-card',
  imports: [IonIcon, AvatarComponent, BskyPostCardComponent, TranslatePipe],
  templateUrl: './popfeed-review-card.component.html',
  styleUrls: ['./popfeed-review-card.component.scss'],
  host: { '[class.popfeed-review--mine]': 'isMine()' },
})
export class PopfeedReviewCardComponent implements OnInit {
  readonly sourceUrl = input.required<string>();
  readonly isMine = input<boolean>(false);

  private reviewRepo = inject(PopfeedReviewRepository);

  readonly state  = signal<'loading' | 'loaded' | 'error'>('loading');
  readonly review = signal<PopfeedReviewView | null>(null);
  readonly spoilerRevealed = signal(false);

  async ngOnInit(): Promise<void> {
    const match = parsePopfeedReviewUrl(this.sourceUrl());
    if (!match) {
      this.state.set('error');
      return;
    }

    const review = await this.reviewRepo.getReview(match);
    if (!review) {
      this.state.set('error');
      return;
    }

    this.review.set(review);
    this.state.set('loaded');
  }

  revealSpoiler(): void {
    this.spoilerRevealed.set(true);
  }

  openExternal(): void {
    window.open(this.sourceUrl(), '_blank', 'noopener,noreferrer');
  }
}
