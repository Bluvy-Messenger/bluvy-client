import {
  Component, Input, Output, EventEmitter,
  ChangeDetectionStrategy, inject, OnDestroy,
} from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { TypingService } from '../../../core/typing/typing.service';
import { TranslatePipe } from '../../../core/i18n/translate.pipe';

@Component({
  selector: 'app-message-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, TranslatePipe],
  templateUrl: './message-composer.component.html',
  styleUrls: ['./message-composer.component.scss'],
})
export class MessageComposerComponent implements OnDestroy {
  @Input() conversationId = '';
  @Input() disabled = false;
  @Output() send = new EventEmitter<string>();

  inputText = '';

  private typingSvc = inject(TypingService);

  onInputChange(event: Event): void {
    this.inputText = (event.target as HTMLInputElement).value;
    if (this.inputText.length > 0) this.typingSvc.startTyping(this.conversationId);
    else this.typingSvc.stopTyping(this.conversationId);
  }

  onKeydown(event: KeyboardEvent): void {
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
