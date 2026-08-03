import {
  Component, Input, Output, EventEmitter,
  ChangeDetectionStrategy, inject, signal, OnChanges, OnDestroy, SimpleChanges,
} from '@angular/core';
import { IonIcon, IonTextarea } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { TypingService } from '../../../core/typing/typing.service';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import type { GiphyGifSummary } from '../../../core/giphy/giphy.types';
import { ComposerLinkPreviewComponent } from '../composer-link-preview/composer-link-preview.component';

@Component({
  selector: 'app-message-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonTextarea, TranslatePipe, GifPickerComponent, ComposerLinkPreviewComponent],
  templateUrl: './message-composer.component.html',
  styleUrls: ['./message-composer.component.scss'],
})
export class MessageComposerComponent implements OnChanges, OnDestroy {
  @Input() conversationId = '';
  @Input() disabled = false;
  // A draft recovered from the outbox (see OutboxRepository) after this device
  // was killed between sending a message and confirming it locally. Only
  // applied on an actual change so it doesn't clobber text the user has
  // already started typing since the conversation opened.
  @Input() initialText = '';
  @Output() send = new EventEmitter<string>();

  inputText = '';
  readonly gifPickerOpen = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialText'] && this.initialText) {
      this.inputText = this.initialText;
    }
  }

  private typingSvc = inject(TypingService);

  onInputChange(event: Event): void {
    this.inputText = (event as CustomEvent<{ value?: string | null }>).detail.value ?? '';
    if (this.inputText.length > 0) this.typingSvc.startTyping(this.conversationId);
    else this.typingSvc.stopTyping(this.conversationId);
  }

  onKeydown(event: KeyboardEvent): void {
    if (Capacitor.isNativePlatform()) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSend();
    }
  }

  onSend(): void {
    const text = this.inputText.trim();
    if (!text || this.disabled) return;
    this.inputText = '';
    this.typingSvc.stopTyping(this.conversationId);
    this.send.emit(text);
  }

  ngOnDestroy(): void {
    if (this.conversationId) this.typingSvc.stopTyping(this.conversationId);
  }

  openGifPicker(): void {
    this.gifPickerOpen.set(true);
  }

  onGifPickerClosed(): void {
    this.gifPickerOpen.set(false);
  }

  // Inserted as a plain giphy.com link -- the existing embed pipeline
  // (EmbedRegistry -> giphyProvider) already renders any such link as a
  // native GIF embed, so no new message type or send path is needed.
  onGifSelected(gif: GiphyGifSummary): void {
    const url = `https://giphy.com/gifs/${gif.id}`;
    this.inputText = this.inputText.trim() ? `${this.inputText.trim()} ${url}` : url;
  }
}
