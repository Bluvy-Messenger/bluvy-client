import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../../infrastructure/api-client.service';
import type { KeyPackageCountResponse } from './key-package.types';
import type { UploadedKeyPackage } from '../mls.types';

@Injectable({ providedIn: 'root' })
export class KeyPackageRepository {
  private apiClient = inject(ApiClientService);

  async getCount(): Promise<KeyPackageCountResponse> {
    return this.apiClient.get<KeyPackageCountResponse>('/v1/key-packages/mine/count');
  }

  async upload(keyPackages: string[]): Promise<{ data: UploadedKeyPackage[] }> {
    return this.apiClient.post<{ data: UploadedKeyPackage[] }>('/v1/key-packages', { keyPackages });
  }
}
