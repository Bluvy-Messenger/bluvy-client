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

  async upload(keyPackages: string[], signedPayload?: unknown): Promise<{ data: UploadedKeyPackage[] }> {
    return this.apiClient.post<{ data: UploadedKeyPackage[] }>('/v1/key-packages', { keyPackages, signedPayload });
  }

  // This device's own unconsumed key packages (id + serialized payload), for
  // the F8 orphan-cleanup reconcile.
  async listMine(cursor?: string): Promise<{ data: Array<{ id: string; keyPackage: string }>; cursor: string | null }> {
    const params: Record<string, string> = {};
    if (cursor) params['cursor'] = cursor;
    return this.apiClient.get<{ data: Array<{ id: string; keyPackage: string }>; cursor: string | null }>(
      '/v1/key-packages/mine', { params },
    );
  }

  async deleteById(id: string): Promise<{ deleted: boolean }> {
    return this.apiClient.delete<{ deleted: boolean }>(`/v1/key-packages/${encodeURIComponent(id)}`);
  }
}
