import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  ViewChild,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonHeader,
  IonToolbar,
  IonContent,
  IonButtons,
  IonButton,
  IonBackButton,
  IonIcon,
  IonFooter,
  IonTextarea,
  IonPopover,
  ActionSheetController,
  AlertController,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  bookmark, bookmarkOutline, pin, pinOutline, cloudDoneOutline,
  timeOutline, alertCircleOutline, send, ellipsisVerticalOutline,
  searchOutline, closeCircle, copyOutline, trashOutline, createOutline,
  closeOutline, syncOutline,
} from 'ionicons/icons';
import { NotesService } from '../../core/notes/notes.service';
import { AuthService } from '../../core/auth/auth.service';
import { BreakpointService } from '../../core/layout/breakpoint.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';
import type { NoteItem } from '../../core/notes/notes.types';

@Component({
  selector: 'app-notes',
  templateUrl: './notes.page.html',
  styleUrls: ['./notes.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonContent,
    IonButtons,
    IonButton,
    IonBackButton,
    IonIcon,
    IonFooter,
    IonTextarea,
    IonPopover,
    TranslatePipe,
  ],
})
export class NotesPage implements OnInit, OnDestroy {
  readonly notesSvc = inject(NotesService);
  private authSvc   = inject(AuthService);
  readonly bpSvc    = inject(BreakpointService);
  private router    = inject(Router);
  private i18n      = inject(TranslationService);
  private actionSheetCtrl = inject(ActionSheetController);
  private alertCtrl = inject(AlertController);
  private toastCtrl = inject(ToastController);

  @ViewChild('notesContent') private contentRef?: IonContent;
  @ViewChild('optionsPopover') private optionsPopover?: IonPopover;

  composerText = '';
  searchQuery = signal<string>('');
  isSearching = signal<boolean>(false);
  editingNoteId = signal<string | null>(null);
  editingText = '';

  readonly filteredNotes = computed(() => {
    const list = this.notesSvc.notes();
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return list;
    return list.filter(n =>
      n.text.toLowerCase().includes(query) ||
      n.tags.some(t => t.toLowerCase().includes(query))
    );
  });

  constructor() {
    addIcons({
      bookmark, bookmarkOutline, pin, pinOutline, cloudDoneOutline,
      timeOutline, alertCircleOutline, send, ellipsisVerticalOutline,
      searchOutline, closeCircle, copyOutline, trashOutline, createOutline,
      closeOutline, syncOutline,
    });
    effect(() => {
      const count = this.notesSvc.notes().length;
      if (count > 0) {
        setTimeout(() => this.scrollToBottom(), 100);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    const user = this.authSvc.currentUser();
    if (user) {
      await this.notesSvc.initialize(user.did);
    }
  }

  ngOnDestroy(): void {
    // Cleanup
  }

  scrollToBottom(): void {
    this.contentRef?.scrollToBottom(200);
  }

  onSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.searchQuery.set(target?.value ?? '');
  }

  onInputChange(event: Event): void {
    const custom = event as CustomEvent<{ value: string }>;
    this.composerText = custom.detail.value ?? '';
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.submitNote();
    }
  }

  async submitNote(): Promise<void> {
    const text = this.composerText.trim();
    if (!text) return;

    this.composerText = '';
    try {
      await this.notesSvc.sendNote(text);
      this.scrollToBottom();
    } catch {
      const toast = await this.toastCtrl.create({
        message: 'Erreur lors de l\'enregistrement de la note.',
        duration: 3000,
        color: 'danger',
      });
      await toast.present();
    }
  }

  startEdit(note: NoteItem): void {
    this.editingNoteId.set(note.id);
    this.editingText = note.text;
  }

  cancelEdit(): void {
    this.editingNoteId.set(null);
    this.editingText = '';
  }

  async saveEdit(note: NoteItem): Promise<void> {
    const text = this.editingText.trim();
    if (!text) return;

    try {
      await this.notesSvc.editNote(note.id, text);
      this.cancelEdit();
    } catch {
      const toast = await this.toastCtrl.create({
        message: 'Erreur lors de la modification de la note.',
        duration: 3000,
        color: 'danger',
      });
      await toast.present();
    }
  }

  async presentNoteActions(note: NoteItem): Promise<void> {
    const actionSheet = await this.actionSheetCtrl.create({
      header: 'Note personnelle',
      buttons: [
        {
          text: 'Copier le texte',
          icon: 'copy-outline',
          handler: () => {
            void navigator.clipboard.writeText(note.text);
            void this.showToast('Texte copié');
          },
        },
        {
          text: note.pinned ? 'Désépingler' : 'Épingler',
          icon: note.pinned ? 'pin' : 'pin-outline',
          handler: () => {
            void this.notesSvc.togglePin(note.id);
          },
        },
        {
          text: 'Modifier',
          icon: 'create-outline',
          handler: () => {
            this.startEdit(note);
          },
        },
        {
          text: 'Supprimer du PDS',
          icon: 'trash-outline',
          role: 'destructive',
          handler: () => {
            void this.confirmDelete(note);
          },
        },
        {
          text: 'Annuler',
          icon: 'close-outline',
          role: 'cancel',
        },
      ],
    });
    await actionSheet.present();
  }

  async openPopover(event: Event): Promise<void> {
    if (this.optionsPopover) {
      this.optionsPopover.event = event;
      await this.optionsPopover.present();
    }
  }

  async syncNow(): Promise<void> {
    await this.optionsPopover?.dismiss();
    await this.notesSvc.syncWithPds();
    await this.showToast('Notes synchronisées avec le PDS');
  }

  toggleSearch(): void {
    void this.optionsPopover?.dismiss();
    this.isSearching.set(!this.isSearching());
    if (!this.isSearching()) {
      this.searchQuery.set('');
    }
  }

  private async confirmDelete(note: NoteItem): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Supprimer la note ?',
      message: 'Cette note sera définitivement supprimée de votre PDS.',
      buttons: [
        { text: 'Annuler', role: 'cancel' },
        {
          text: 'Supprimer',
          role: 'destructive',
          handler: () => {
            void this.notesSvc.deleteNote(note.id);
          },
        },
      ],
    });
    await alert.present();
  }

  private async showToast(message: string): Promise<void> {
    const toast = await this.toastCtrl.create({
      message,
      duration: 2000,
    });
    await toast.present();
  }

  formatTime(ts: number): string {
    const d = new Date(ts);
    const locale = this.i18n.locale === 'fr' ? 'fr-FR' : 'en-US';
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }

  getDateSeparator(index: number): string | null {
    const notes = this.filteredNotes();
    const current = notes[index];
    if (!current) return null;
    if (index === 0) return this.formatDateLabel(current.createdAt);

    const prev = notes[index - 1];
    if (!prev) return null;

    const d1 = new Date(prev.createdAt).toDateString();
    const d2 = new Date(current.createdAt).toDateString();
    return d1 !== d2 ? this.formatDateLabel(current.createdAt) : null;
  }

  private formatDateLabel(ts: number): string {
    const d = new Date(ts);
    const locale = this.i18n.locale === 'fr' ? 'fr-FR' : 'en-US';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return this.i18n.locale === 'fr' ? "Aujourd'hui" : 'Today';
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) {
      return this.i18n.locale === 'fr' ? 'Hier' : 'Yesterday';
    }
    return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  }
}
