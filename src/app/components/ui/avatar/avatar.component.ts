import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './avatar.component.html',
  styleUrls: ['./avatar.component.scss'],
})
export class AvatarComponent {
  @Input() src: string | null = null;
  @Input() handle = '';
  @Input() size: 'sm' | 'md' | 'lg' | 'xl' = 'md';

  get initials(): string {
    return this.handle[0]?.toUpperCase() ?? '?';
  }

  get safeSrc(): string | null {
    if (!this.src || !this.src.startsWith('https://cdn.bsky.app/')) return null;
    return this.src;
  }
}
