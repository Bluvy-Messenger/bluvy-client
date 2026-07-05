import { Injectable, inject } from '@angular/core';
import type {
  Argon2idHkdfParams,
  BackupKeyVersionResponse,
  BackupMessageInput,
  BackupSettings,
  EncryptedBackupPayload,
} from './backup.types';
import type { Paginated } from '../infrastructure/pagination.types';
import { ApiClientService } from '../infrastructure/api-client.service';
import {
  validateBackupKeyVersionsResponse,
  validateBackupMessageIdsPage,
  validateBackupMessagePage,
  validateBackupSettings,
} from './backup.validator';

const API = '/v1/backup';

interface KeyVersionCreatedResponse {
  id:            string;
  versionNumber: number;
  createdAt:     number;
}

interface BackupMessageRecord {
  id:                string;
  messageId:         string;
  conversationId:    string;
  encryptedPayload:  EncryptedBackupPayload;
  encryptionVersion: number;
  cacheVersion:      number;
  keyVersion:        number;
  createdAt:         number;
}

export type BackupMessagePage = Paginated<BackupMessageRecord>;

export type BackupMessageIdsPage = Paginated<{ messageId: string; createdAt: number }>;

@Injectable({ providedIn: 'root' })
export class BackupRepository {
  private apiClient = inject(ApiClientService);

  async getSettings(): Promise<BackupSettings> {
    const raw = await this.apiClient.get<BackupSettings>(`${API}/settings`);
    return validateBackupSettings(raw);
  }

  updateSettings(enabled: boolean): Promise<unknown> {
    return this.apiClient.put(`${API}/settings`, { enabled });
  }

  createKeyVersion(kdfAlgorithm: string, kdfParams: Argon2idHkdfParams): Promise<KeyVersionCreatedResponse> {
    return this.apiClient.post<KeyVersionCreatedResponse>(`${API}/key-versions`, { kdfAlgorithm, kdfParams });
  }

  async getKeyVersions(): Promise<{ data: BackupKeyVersionResponse[] }> {
    const raw = await this.apiClient.get<{ data: BackupKeyVersionResponse[] }>(`${API}/key-versions`);
    return validateBackupKeyVersionsResponse(raw);
  }

  async getMessages(params: Record<string, string>): Promise<BackupMessagePage> {
    const raw = await this.apiClient.get<BackupMessagePage>(`${API}/messages`, { params });
    return validateBackupMessagePage(raw);
  }

  async getMessageIds(params: Record<string, string>): Promise<BackupMessageIdsPage> {
    const raw = await this.apiClient.get<BackupMessageIdsPage>(`${API}/messages/ids`, { params });
    return validateBackupMessageIdsPage(raw);
  }

  postMessages(messages: BackupMessageInput[]): Promise<unknown> {
    return this.apiClient.post<unknown>(`${API}/messages`, { messages });
  }

  deleteMessages(): Promise<{ deleted: number }> {
    return this.apiClient.delete<{ deleted: number }>(`${API}/messages`, { params: { confirm: 'true' } });
  }
}
