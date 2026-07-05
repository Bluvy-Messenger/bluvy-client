import { Injectable, inject } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';

interface SeoConfig {
  title: string;
  description: string;
  canonicalPath?: string;
}

@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly titleSvc = inject(Title);
  private readonly meta     = inject(Meta);

  set(config: SeoConfig): void {
    const full = config.title === 'Bluvy Messenger'
      ? config.title
      : `${config.title} — Bluvy Messenger`;

    this.titleSvc.setTitle(full);
    this.meta.updateTag({ name: 'description',         content: config.description });
    this.meta.updateTag({ property: 'og:title',        content: full });
    this.meta.updateTag({ property: 'og:description',  content: config.description });
    this.meta.updateTag({ property: 'og:url',          content: `https://bluvy.app${config.canonicalPath ?? ''}` });
    this.meta.updateTag({ name: 'twitter:title',       content: full });
    this.meta.updateTag({ name: 'twitter:description', content: config.description });
  }
}
