import {
  Component, input, output,
  inject, signal, computed, effect,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { happyOutline, returnUpBackOutline, checkmarkOutline, checkmarkDoneOutline, checkmarkDone, alertCircleOutline, refreshOutline } from 'ionicons/icons';
import { TranslatePipe } from '@ngx-translate/core';

import { AvatarComponent } from '../../ui/avatar/avatar.component';
import { EmbedPreviewBlockComponent } from '../embed-preview-block/embed-preview-block.component';
import { PlaceEmbedComponent } from '../place-embed/place-embed.component';
import type { MessageReplyTo, ReactionMap } from '../../../core/conversation/conversation.types';
import type { PlaceData } from '../../../core/place/place.types';
import { LinkPreviewService } from '../../../core/link-preview/link-preview.service';
import { EmbedRegistry } from '../../../core/embed/embed-registry.service';
import type { EmbedMatch } from '../../../core/embed/embed-provider.types';
import type { LinkPreviewMeta } from '../../../core/link-preview/link-preview.types';
import { extractAllUrls, classifyMessageLink, type ExtractedUrl } from '../../../core/message-link/detect-message-link.util';

export interface ReactionEntry {
  emoji: string;
  count: number;
  hasReacted: boolean;
}

interface EmbedPreviewSlot {
  key: string;
  bskyPostUrl?: string;
  popfeedReviewUrl?: string;
  embed?: { match: EmbedMatch; url: string };
  preview?: LinkPreviewMeta;
  previewImageSrc?: string | null;
}

const EMPTY_SLOT: Omit<EmbedPreviewSlot, 'key'> = {};

@Component({
  selector: 'app-message-bubble',
  imports: [DatePipe, IonIcon, EmbedPreviewBlockComponent, PlaceEmbedComponent, TranslatePipe, AvatarComponent],
  templateUrl: './message-bubble.component.html',
  styleUrls: ['./message-bubble.component.scss'],
})
export class MessageBubbleComponent {
  readonly messageId = input<string>('');
  readonly text = input<string>('');
  readonly isMine = input<boolean>(false);
  readonly timestamp = input<number>(0);
  readonly pending = input<boolean>(false);
  readonly failed = input<boolean>(false);
  readonly position = input<'first' | 'middle' | 'last' | 'single'>('single');
  readonly receiptStatus = input<'read' | 'delivered' | 'sent' | null>(null);
  readonly replyTo = input<MessageReplyTo | null>(null);
  readonly reactions = input<ReactionMap | undefined>(undefined);
  readonly currentUserId = input<string>('');
  readonly senderName = input<string | null>(null);
  readonly senderAvatarUrl = input<string | null>(null);
  readonly place = input<PlaceData | null>(null);

  readonly reply = output<void>();
  readonly retry = output<void>();
  readonly toggleReaction = output<string>();
  readonly jumpToReply = output<string>();

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

  private linkPreviewSvc = inject(LinkPreviewService);
  private embedRegistry  = inject(EmbedRegistry);

  links       = signal<EmbedPreviewSlot[]>([]);
  displayText = signal('');
  private lastKey: string | undefined = undefined;
  private pendingText = '';

  readonly showSenderInfo = computed(() => {
    return !this.isMine() && (this.position() === 'first' || this.position() === 'single');
  });

  readonly reactionEntries = computed<ReactionEntry[]>(() => {
    const r = this.reactions();
    if (!r) return [];
    const entries: ReactionEntry[] = [];
    const uid = this.currentUserId();
    for (const [emoji, users] of Object.entries(r)) {
      if (Array.isArray(users) && users.length > 0) {
        entries.push({
          emoji,
          count: users.length,
          hasReacted: uid ? users.includes(uid) : false,
        });
      }
    }
    return entries;
  });

  constructor() {
    addIcons({ happyOutline, returnUpBackOutline, checkmarkOutline, checkmarkDoneOutline, checkmarkDone, alertCircleOutline, refreshOutline });

    effect(() => {
      const rawText = this.text();
      this.pendingText = rawText;
      this.displayText.set(rawText);

      const extracted = extractAllUrls(rawText);
      const key = extracted.map((e: ExtractedUrl) => e.url).join('\n');
      if (key === this.lastKey) return;
      this.lastKey = key;

      this.links.set(extracted.map((e: ExtractedUrl, i: number) => ({ key: `${i}-${e.url}`, ...EMPTY_SLOT })));

      extracted.forEach((extractedUrl: ExtractedUrl, index: number) => {
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
    });
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
    if (this.failed()) {
      this.onRetryClick();
      return;
    }
    const now = Date.now();
    if (now - this.lastTapTime < 320) {
      this.toggleReaction.emit('❤️');
      this.lastTapTime = 0;
    } else {
      this.lastTapTime = now;
    }
  }

  onRetryClick(e?: MouseEvent): void {
    e?.stopPropagation();
    this.retry.emit();
  }

  getReactorsTooltip(emoji: string): string {
    const r = this.reactions();
    if (!r || !r[emoji]) return '';
    const userDids = r[emoji];
    const names = userDids.map(did => (did === this.currentUserId() ? 'Vous' : 'Membre'));
    return names.join(', ');
  }

  private resolveSlot(key: string, index: number, rawMatch: string, patch: Partial<EmbedPreviewSlot>): void {
    if (this.lastKey !== key) return;
    this.links.update(arr => arr.map((s, i) => i === index ? { ...s, ...patch } : s));
    this.pendingText = this.pendingText.replace(rawMatch, '');
    this.displayText.set(this.pendingText.trim());
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
    const reply = this.replyTo();
    if (reply?.messageId) {
      this.jumpToReply.emit(reply.messageId);
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
