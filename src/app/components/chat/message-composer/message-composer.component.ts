import {
  Component, input, output,
  inject, signal, effect, OnDestroy,
} from '@angular/core';
import { IonIcon, IonTextarea, IonPopover } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { add, locationOutline, send, returnUpBackOutline, closeOutline } from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import { TypingService } from '../../../core/typing/typing.service';
import { TranslatePipe } from '@ngx-translate/core';

import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { PlacePickerModalComponent } from '../place-picker-modal/place-picker-modal.component';
import type { GiphyGifSummary } from '../../../core/giphy/giphy.types';
import type { PlaceData } from '../../../core/place/place.types';
import { ComposerLinkPreviewComponent } from '../composer-link-preview/composer-link-preview.component';
import type { MessageReplyTo } from '../../../core/conversation/conversation.types';

@Component({
  selector: 'app-message-composer',
  imports: [
    IonIcon,
    IonTextarea,
    IonPopover,
    TranslatePipe,
    GifPickerComponent,
    PlacePickerModalComponent,
    ComposerLinkPreviewComponent,
  ],
  templateUrl: './message-composer.component.html',
  styleUrls: ['./message-composer.component.scss'],
})
export class MessageComposerComponent implements OnDestroy {
  readonly conversationId = input<string>('');
  readonly disabled = input<boolean>(false);
  readonly replyTo = input<MessageReplyTo | null>(null);
  readonly initialText = input<string>('');

  readonly send = output<string>();
  readonly sendPlace = output<PlaceData>();
  readonly cancelReply = output<void>();

  inputText = '';
  readonly gifPickerOpen = signal(false);
  readonly placePickerOpen = signal(false);
  readonly attachMenuOpen = signal(false);
  attachEvent: Event | null = null;

  private typingSvc = inject(TypingService);

  constructor() {
    addIcons({ add, locationOutline, send, returnUpBackOutline, closeOutline });
    effect(() => {
      const draft = this.initialText();
      if (draft) {
        this.inputText = draft;
      }
    });
  }

  onInputChange(event: Event): void {
    const convId = this.conversationId();
    this.inputText = (event as CustomEvent<{ value?: string | null }>).detail.value ?? '';
    if (this.inputText.length > 0) this.typingSvc.startTyping(convId);
    else this.typingSvc.stopTyping(convId);
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
    if (!text || this.disabled()) return;
    this.inputText = '';
    this.typingSvc.stopTyping(this.conversationId());
    this.send.emit(text);
  }

  ngOnDestroy(): void {
    const convId = this.conversationId();
    if (convId) this.typingSvc.stopTyping(convId);
  }

  openGifPicker(): void {
    this.gifPickerOpen.set(true);
  }

  onGifPickerClosed(): void {
    this.gifPickerOpen.set(false);
  }

  openAttachMenu(event: Event): void {
    this.attachEvent = event;
    this.attachMenuOpen.set(true);
  }

  openPlacePicker(): void {
    this.attachMenuOpen.set(false);
    this.placePickerOpen.set(true);
  }

  onPlacePickerClosed(): void {
    this.placePickerOpen.set(false);
  }

  onPlaceSelected(place: PlaceData): void {
    this.sendPlace.emit(place);
  }

  onGifSelected(gif: GiphyGifSummary): void {
    const url = `https://giphy.com/gifs/${gif.id}`;
    this.inputText = this.inputText.trim() ? `${this.inputText.trim()} ${url}` : url;
  }
}
