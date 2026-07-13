import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { JournalService, JournalEntry, LogLevel } from '../../core/journal/journal.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';

@Component({
  selector: 'app-settings-logs',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-logs.page.html',
  styleUrls: ['./settings-logs.page.scss'],
})
export class SettingsLogsPage implements OnInit {
  private readonly router  = inject(Router);
  private readonly journal = inject(JournalService);

  readonly allEntries  = signal<JournalEntry[]>([]);
  readonly filter      = signal<LogLevel | 'all'>('all');
  readonly copied      = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    const entries = await this.journal.getEntries();
    this.allEntries.set(entries);
  }

  get entries(): JournalEntry[] {
    const f = this.filter();
    if (f === 'all') return this.allEntries();
    return this.allEntries().filter(e => e.level === f);
  }

  setFilter(f: LogLevel | 'all'): void {
    this.filter.set(f);
  }

  async clearLogs(): Promise<void> {
    this.journal.clearAll();
    this.allEntries.set([]);
  }

  async copyLogs(): Promise<void> {
    const text = this.entries
      .map(e => {
        const d = new Date(e.timestamp).toISOString();
        const base = `[${d}] [${e.level.toUpperCase()}] ${e.tag} ${e.message}`;
        return e.detail ? base + '\n' + e.detail : base;
      })
      .join('\n');
    await navigator.clipboard.writeText(text).catch(() => {});
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  goBack(): void {
    void this.router.navigate(['/about']);
  }

  formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
}
