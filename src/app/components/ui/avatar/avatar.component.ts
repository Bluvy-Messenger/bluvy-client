import { Component, input, computed } from '@angular/core';

@Component({
  selector: 'app-avatar',
  templateUrl: './avatar.component.html',
  styleUrls: ['./avatar.component.scss'],
})
export class AvatarComponent {
  readonly src = input<string | null>(null);
  readonly handle = input<string>('');
  readonly size = input<'sm' | 'md' | 'lg' | 'xl'>('md');

  readonly initials = computed(() => {
    const h = this.handle();
    return h[0]?.toUpperCase() ?? '?';
  });

  readonly safeSrc = computed(() => {
    const s = this.src();
    if (!s || !s.startsWith('https://cdn.bsky.app/')) return null;
    return s;
  });
}
