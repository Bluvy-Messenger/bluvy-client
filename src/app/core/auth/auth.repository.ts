import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../infrastructure/api-client.service';
import type { UserProfile, AuthResponse, AuthSessionResponse, RefreshResponse } from './auth.types';

@Injectable({ providedIn: 'root' })
export class AuthRepository {
  private apiClient = inject(ApiClientService);

  // atprotoAccessToken now carries a com.atproto.server.getServiceAuth token
  // (short-lived, account-signed), not the raw OAuth access token.
  async login(
    atprotoAccessToken: string,
    did:                string,
    deviceId:           string,
    deviceName:         string,
    platform:           string,
  ): Promise<AuthResponse> {
    return this.apiClient.post<AuthResponse>('/v1/auth/login', {
      atprotoAccessToken,
      did,
      deviceId,
      deviceName,
      platform,
    }, { skipAuth: true });
  }

  async getSession(): Promise<AuthSessionResponse> {
    return this.apiClient.get<AuthSessionResponse>('/v1/auth/me');
  }

  async logout(): Promise<void> {
    await this.apiClient.post('/v1/auth/logout', {});
  }

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    return this.apiClient.post<RefreshResponse>(
      '/v1/auth/refresh',
      { refreshToken },
      { skipAuth: true },
    );
  }
}
