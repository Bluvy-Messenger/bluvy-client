import {
  Component, Input, Output, EventEmitter,
  ChangeDetectionStrategy, inject, OnChanges, OnDestroy, SimpleChanges,
} from '@angular/core';
import { IonIcon, IonTextarea } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { TypingService } from '../../../core/typing/typing.service';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';

@Component({
  selector: 'app-message-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonTextarea, TranslatePipe],
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
}
