import { Injectable, inject } from '@angular/core';
import type { EncryptedSyncPayload, MbkBlob, SyncDataInput, SyncSettings } from './sync.types';
import type { Paginated } from '../infrastructure/pagination.types';
import { ApiClientService } from '../infrastructure/api-client.service';
import {
  validateMbkBlob,
  validateSyncDataIdsPage,
  validateSyncDataPage,
  validateSyncSettings,
} from './sync.validator';

const API = '/v1/sync';

interface SyncDataRecord {
  id:                string;
  messageId:         string;
  conversationId:    string;
  encryptedPayload:  EncryptedSyncPayload;
  encryptionVersion: number;
  cacheVersion:      number;
  keyVersion:        number;
  createdAt:         number;
}

export type SyncDataPage = Paginated<SyncDataRecord>;

export type SyncDataIdsPage = Paginated<{ messageId: string; createdAt: number }>;

@Injectable({ providedIn: 'root' })
export class SyncRepository {
  private apiClient = inject(ApiClientService);

  async getSettings(): Promise<SyncSettings> {
    const raw = await this.apiClient.get<SyncSettings>(`${API}/settings`);
    return validateSyncSettings(raw);
  }

  async getMbk(): Promise<MbkBlob> {
    const raw = await this.apiClient.get<MbkBlob>(`${API}/mbk`);
    return validateMbkBlob(raw);
  }

  putMbk(blob: MbkBlob): Promise<unknown> {
    return this.apiClient.put(`${API}/mbk`, blob);
  }

  async getRecoveryMbk(): Promise<MbkBlob> {
    const raw = await this.apiClient.get<MbkBlob>(`${API}/recovery-mbk`);
    return validateMbkBlob(raw);
  }

  putRecoveryMbk(blob: MbkBlob): Promise<unknown> {
    return this.apiClient.put(`${API}/recovery-mbk`, blob);
  }

  async getData(params: Record<string, string>): Promise<SyncDataPage> {
    const raw = await this.apiClient.get<SyncDataPage>(`${API}/data`, { params });
    return validateSyncDataPage(raw);
  }

  async getDataIds(params: Record<string, string>): Promise<SyncDataIdsPage> {
    const raw = await this.apiClient.get<SyncDataIdsPage>(`${API}/data/ids`, { params });
    return validateSyncDataIdsPage(raw);
  }

  postData(items: SyncDataInput[]): Promise<unknown> {
    return this.apiClient.post<unknown>(`${API}/data`, { messages: items });
  }

  deleteData(): Promise<{ deleted: number }> {
    return this.apiClient.delete<{ deleted: number }>(`${API}/data`, { params: { confirm: 'true' } });
  }
}
