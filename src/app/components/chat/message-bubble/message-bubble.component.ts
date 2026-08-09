import { Component, Input, OnChanges, SimpleChanges, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { happyOutline, returnUpBackOutline, checkmarkOutline, checkmarkDoneOutline, checkmarkDone } from 'ionicons/icons';
import { LinkPreviewService } from '../../../core/link-preview/link-preview.service';
import type { LinkPreviewMeta } from '../../../core/link-preview/link-preview.types';
import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import { extractAllUrls, classifyMessageLink } from '../../../core/message-link/detect-message-link.util';
import { EmbedPreviewBlockComponent, type EmbedPreviewEmbed } from '../embed-preview-block/embed-preview-block.component';

// One slot per link found in the message, in the same left-to-right order
// they appear in the text -- populated in place as each resolves (some
// synchronously, the generic OG-scrape case asynchronously) so the stack of
// cards never reorders itself once a later link's fetch beats an earlier one.
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import type { MessageReplyTo, ReactionMap } from '../../../core/conversation/conversation.types';
import { Output, EventEmitter } from '@angular/core';

interface EmbedPreviewSlot {
  key: string;
  bskyPostUrl: string | null;
  popfeedReviewUrl: string | null;
  embed: EmbedPreviewEmbed | null;
  preview: LinkPreviewMeta | null;
  previewImageSrc: string | null;
}

const EMPTY_SLOT: Omit<EmbedPreviewSlot, 'key'> = {
  bskyPostUrl: null, popfeedReviewUrl: null, embed: null, preview: null, previewImageSrc: null,
};

export interface ReactionEntry {
  emoji: string;
  count: number;
  hasReacted: boolean;
}

@Component({
  selector: 'app-message-bubble',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, IonIcon, EmbedPreviewBlockComponent, TranslatePipe],
  templateUrl: './message-bubble.component.html',
  styleUrls: ['./message-bubble.component.scss'],
})
export class MessageBubbleComponent implements OnChanges {
  @Input() messageId = '';
  @Input() text = '';
  @Input() isMine = false;
  @Input() timestamp = 0;
  @Input() pending = false;
  @Input() position: 'first' | 'middle' | 'last' | 'single' = 'single';
  @Input() receiptStatus: 'read' | 'delivered' | 'sent' | null = null;
  @Input() replyTo: MessageReplyTo | null = null;
  @Input() reactions: ReactionMap | undefined = undefined;
  @Input() currentUserId = '';

  @Output() reply = new EventEmitter<void>();
  @Output() toggleReaction = new EventEmitter<string>();
  @Output() jumpToReply = new EventEmitter<string>();

  readonly showEmojiPicker = signal(false);
  readonly showFullPicker  = signal(false);
  showActions = false;
  isLongPressActive = false;
  swipeOffset = 0;
  private touchStartX = 0;
  private lastTapTime = 0;

  readonly expandedEmojis = [
    '😀', '😂', '😍', '🥳', '🤩', '😎', '💩', '🤡', '👻', '🤖',
    '👍', '👎', '👏', '🙌', '🤝', '👊', '✌️', '🤞', '🤟', '🙏',
    '❤️', '💔', '💖', '🔥', '✨', '🌟', '💯', '🎉', '🚀', '💡',
  ];

  constructor() {
    addIcons({ happyOutline, returnUpBackOutline, checkmarkOutline, checkmarkDoneOutline, checkmarkDone });
  }

  toggleEmojiPicker(): void {
    this.showEmojiPicker.update(v => !v);
    if (!this.showEmojiPicker()) this.showFullPicker.set(false);
  }

  toggleFullPicker(e: MouseEvent): void {
    e.stopPropagation();
    this.showFullPicker.update(v => !v);
  }

  onBubbleClick(): void {
    const now = Date.now();
    if (now - this.lastTapTime < 320) {
      this.toggleReaction.emit('❤️');
      this.lastTapTime = 0;
    } else {
      this.lastTapTime = now;
    }
  }

  getReactorsTooltip(emoji: string): string {
    if (!this.reactions || !this.reactions[emoji]) return '';
    const userDids = this.reactions[emoji];
    const names = userDids.map(did => (did === this.currentUserId ? 'Vous' : 'Membre'));
    return names.join(', ');
  }

  private linkPreviewSvc = inject(LinkPreviewService);
  private embedRegistry  = inject(EmbedRegistry);

  links       = signal<EmbedPreviewSlot[]>([]);
  // Full text until each link's card actually resolves — only then is that
  // link's raw URL stripped, so there's no flash of text disappearing
  // before the card is confirmed available.
  displayText = signal('');

  // undefined (not '') so it never coincidentally matches a real, empty
  // "no links found" key on the very first change.
  private lastKey: string | undefined = undefined;
  private pendingText = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['text']) return;

    // Unconditional, regardless of the lastKey guard below: displayText must
    // always reflect the current text input. A no-links message always
    // computes the same empty key, so gating this on the guard would (and
    // did) leave displayText permanently blank for every plain-text message.
    this.pendingText = this.text;
    this.displayText.set(this.text);

    const extracted = extractAllUrls(this.text);
    const key = extracted.map(e => e.url).join('\n');
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Index prefix guarantees a unique @for track key even if the same URL
    // is pasted twice in one message.
    this.links.set(extracted.map((e, i) => ({ key: `${i}-${e.url}`, ...EMPTY_SLOT })));

    extracted.forEach((extractedUrl, index) => {
      const { url, rawMatch } = extractedUrl;
      const classified = classifyMessageLink(url, this.embedRegistry);

      switch (classified.kind) {
        case 'bskyPost':
          this.resolveSlot(key, index, rawMatch, { bskyPostUrl: url });
          return;
        case 'popfeedReview':
          this.resolveSlot(key, index, rawMatch, { popfeedReviewUrl: url });
          return;
        case 'embed':
          this.resolveSlot(key, index, rawMatch, { embed: { match: classified.match, url } });
          return;
        case 'generic':
          void this.linkPreviewSvc.getPreview(url).then(meta => {
            if (this.lastKey !== key) return;
            // Even when scraping finds no title (e.g. a client-rendered SPA
            // with no SSR content), still show a minimal hostname-only card
            // -- never just silently leave the raw URL as inert plain text.
            this.resolveSlot(key, index, rawMatch, {
              preview: {
                url,
                status: meta?.status ?? 'unavailable',
                title: meta?.title ?? null,
                description: meta?.description ?? null,
                siteName: meta?.siteName ?? null,
                imageUrl: meta?.imageUrl ?? null,
              },
            });

            if (meta?.imageUrl) {
              void this.linkPreviewSvc.getImageObjectUrl(meta.imageUrl).then(src => {
                if (this.lastKey === key) {
                  this.links.update(arr => arr.map((s, i) => i === index ? { ...s, previewImageSrc: src } : s));
                }
              });
            }
          });
          return;
      }
    });
  }

  private resolveSlot(key: string, index: number, rawMatch: string, patch: Partial<EmbedPreviewSlot>): void {
    if (this.lastKey !== key) return;
    this.links.update(arr => arr.map((s, i) => i === index ? { ...s, ...patch } : s));
    this.pendingText = this.pendingText.replace(rawMatch, '');
    this.displayText.set(this.pendingText.trim());
  }

  get reactionEntries(): ReactionEntry[] {
    if (!this.reactions) return [];
    const entries: ReactionEntry[] = [];
    for (const [emoji, users] of Object.entries(this.reactions)) {
      if (Array.isArray(users) && users.length > 0) {
        entries.push({
          emoji,
          count: users.length,
          hasReacted: this.currentUserId ? users.includes(this.currentUserId) : false,
        });
      }
    }
    return entries;
  }

  onReactionSelect(emoji: string): void {
    this.toggleReaction.emit(emoji);
    this.showActions = false;
    this.showEmojiPicker.set(false);
    this.showFullPicker.set(false);
  }

  onReplyClick(): void {
    this.reply.emit();
    this.showActions = false;
    this.showEmojiPicker.set(false);
    this.showFullPicker.set(false);
  }

  onQuoteClick(e: MouseEvent): void {
    e.stopPropagation();
    if (this.replyTo?.messageId) {
      this.jumpToReply.emit(this.replyTo.messageId);
    }
  }

  onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      this.touchStartX = e.touches[0].clientX;
    }
  }

  onTouchMove(e: TouchEvent): void {
    if (this.touchStartX > 0 && e.touches.length === 1) {
      const deltaX = e.touches[0].clientX - this.touchStartX;
      if (deltaX > 0 && deltaX < 90) {
        this.swipeOffset = deltaX;
      }
    }
  }

  onTouchEnd(): void {
    if (this.swipeOffset > 45) {
      this.onReplyClick();
    }
    this.swipeOffset = 0;
    this.touchStartX = 0;
  }
}

