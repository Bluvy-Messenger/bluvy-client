import type { BackupKeyVersionResponse, BackupSettings } from './backup.types';
import type { BackupMessageIdsPage, BackupMessagePage } from './backup.repository';
import { isObject } from '../infrastructure/validation.util';

export function validateBackupSettings(data: BackupSettings): BackupSettings {
  if (!isObject(data)) throw new Error('BackupSettings: expected object');
  if (typeof data['enabled'] !== 'boolean') throw new Error('BackupSettings.enabled: expected boolean');
  if (data['currentKeyVersion'] !== null && typeof data['currentKeyVersion'] !== 'number') {
    throw new Error('BackupSettings.currentKeyVersion: expected number or null');
  }
  if (data['enabledAt'] !== null && typeof data['enabledAt'] !== 'number') {
    throw new Error('BackupSettings.enabledAt: expected number or null');
  }
  if (data['lastBackupAt'] !== null && typeof data['lastBackupAt'] !== 'number') {
    throw new Error('BackupSettings.lastBackupAt: expected number or null');
  }
  return data;
}

export function validateBackupKeyVersionResponse(data: BackupKeyVersionResponse): BackupKeyVersionResponse {
  if (!isObject(data)) throw new Error('BackupKeyVersionResponse: expected object');
  if (typeof data['id'] !== 'string') throw new Error('BackupKeyVersionResponse.id: expected string');
  if (typeof data['userDid'] !== 'string') throw new Error('BackupKeyVersionResponse.userDid: expected string');
  if (typeof data['versionNumber'] !== 'number') throw new Error('BackupKeyVersionResponse.versionNumber: expected number');
  if (typeof data['kdfAlgorithm'] !== 'string') throw new Error('BackupKeyVersionResponse.kdfAlgorithm: expected string');
  if (!isObject(data['kdfParams'])) throw new Error('BackupKeyVersionResponse.kdfParams: expected object');
  if (typeof data['createdAt'] !== 'number') throw new Error('BackupKeyVersionResponse.createdAt: expected number');
  if (data['supersededAt'] !== null && typeof data['supersededAt'] !== 'number') {
    throw new Error('BackupKeyVersionResponse.supersededAt: expected number or null');
  }
  return data;
}

export function validateBackupKeyVersionsResponse(data: { data: BackupKeyVersionResponse[] }): { data: BackupKeyVersionResponse[] } {
  if (!isObject(data)) throw new Error('BackupKeyVersionsResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('BackupKeyVersionsResponse.data: expected array');
  return { data: data['data'].map(validateBackupKeyVersionResponse) };
}

export function validateBackupMessagePage(data: BackupMessagePage): BackupMessagePage {
  if (!isObject(data)) throw new Error('BackupMessagePage: expected object');
  if (!Array.isArray(data['data'])) throw new Error('BackupMessagePage.data: expected array');
  if (data['cursor'] !== null && typeof data['cursor'] !== 'string') {
    throw new Error('BackupMessagePage.cursor: expected string or null');
  }
  if (typeof data['hasMore'] !== 'boolean') throw new Error('BackupMessagePage.hasMore: expected boolean');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('BackupMessagePage.data[]: expected object');
    if (typeof item['id'] !== 'string') throw new Error('BackupMessagePage.data[].id: expected string');
    if (typeof item['messageId'] !== 'string') throw new Error('BackupMessagePage.data[].messageId: expected string');
  }
  return data;
}

export function validateBackupMessageIdsPage(data: BackupMessageIdsPage): BackupMessageIdsPage {
  if (!isObject(data)) throw new Error('BackupMessageIdsPage: expected object');
  if (!Array.isArray(data['data'])) throw new Error('BackupMessageIdsPage.data: expected array');
  if (data['cursor'] !== null && typeof data['cursor'] !== 'string') {
    throw new Error('BackupMessageIdsPage.cursor: expected string or null');
  }
  if (typeof data['hasMore'] !== 'boolean') throw new Error('BackupMessageIdsPage.hasMore: expected boolean');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('BackupMessageIdsPage.data[]: expected object');
    if (typeof item['messageId'] !== 'string') throw new Error('BackupMessageIdsPage.data[].messageId: expected string');
    if (typeof item['createdAt'] !== 'number') throw new Error('BackupMessageIdsPage.data[].createdAt: expected number');
  }
  return data;
}
