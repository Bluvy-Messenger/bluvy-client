import { Injectable, inject } from '@angular/core';
import { TokenRepository } from './token.repository';

@Injectable({ providedIn: 'root' })
export class StorageService {
  private repo = inject(TokenRepository);

  async setAccessToken(token: string): Promise<void> {
    return this.repo.setAccessToken(token);
  }

  async getAccessToken(): Promise<string | null> {
    return this.repo.getAccessToken();
  }

  async setRefreshToken(token: string): Promise<void> {
    return this.repo.setRefreshToken(token);
  }

  async getRefreshToken(): Promise<string | null> {
    return this.repo.getRefreshToken();
  }

  async clearAll(): Promise<void> {
    return this.repo.clearTokens();
  }

}
