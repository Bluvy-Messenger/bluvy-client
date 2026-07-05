import type { MbkBlob, SyncSettings } from './sync.types';
import type { SyncDataPage, SyncDataIdsPage } from './sync.repository';
import { isObject } from '../infrastructure/validation.util';

export function validateSyncSettings(data: SyncSettings): SyncSettings {
  if (!isObject(data)) throw new Error('SyncSettings: expected object');
  if (typeof data['hasMbk'] !== 'boolean') throw new Error('SyncSettings.hasMbk: expected boolean');
  if (typeof data['hasLegacyBackup'] !== 'boolean') throw new Error('SyncSettings.hasLegacyBackup: expected boolean');
  if (data['setupAt'] !== null && typeof data['setupAt'] !== 'number') {
    throw new Error('SyncSettings.setupAt: expected number or null');
  }
  if (data['lastSyncAt'] !== null && typeof data['lastSyncAt'] !== 'number') {
    throw new Error('SyncSettings.lastSyncAt: expected number or null');
  }
  return data;
}

export function validateMbkBlob(data: MbkBlob): MbkBlob {
  if (!isObject(data)) throw new Error('MbkBlob: expected object');
  if (!isObject(data['encryptedMbk'])) throw new Error('MbkBlob.encryptedMbk: expected object');
  const encryptedMbk = data['encryptedMbk'];
  if (typeof encryptedMbk['iv'] !== 'string') throw new Error('MbkBlob.encryptedMbk.iv: expected string');
  if (typeof encryptedMbk['data'] !== 'string') throw new Error('MbkBlob.encryptedMbk.data: expected string');
  if (typeof data['kdfAlgorithm'] !== 'string') throw new Error('MbkBlob.kdfAlgorithm: expected string');
  if (!isObject(data['kdfParams'])) throw new Error('MbkBlob.kdfParams: expected object');
  const kdfParams = data['kdfParams'];
  if (typeof kdfParams['argon2Salt'] !== 'string') throw new Error('MbkBlob.kdfParams.argon2Salt: expected string');
  if (typeof kdfParams['argon2Memory'] !== 'number') throw new Error('MbkBlob.kdfParams.argon2Memory: expected number');
  if (typeof kdfParams['argon2Iterations'] !== 'number') throw new Error('MbkBlob.kdfParams.argon2Iterations: expected number');
  if (typeof kdfParams['argon2Parallelism'] !== 'number') throw new Error('MbkBlob.kdfParams.argon2Parallelism: expected number');
  if (typeof kdfParams['hkdfSalt'] !== 'string') throw new Error('MbkBlob.kdfParams.hkdfSalt: expected string');
  if (typeof kdfParams['hkdfInfo'] !== 'string') throw new Error('MbkBlob.kdfParams.hkdfInfo: expected string');
  if (typeof kdfParams['keyLength'] !== 'number') throw new Error('MbkBlob.kdfParams.keyLength: expected number');
  return data;
}

export function validateSyncDataPage(data: SyncDataPage): SyncDataPage {
  if (!isObject(data)) throw new Error('SyncDataPage: expected object');
  if (!Array.isArray(data['data'])) throw new Error('SyncDataPage.data: expected array');
  if (data['cursor'] !== null && typeof data['cursor'] !== 'string') {
    throw new Error('SyncDataPage.cursor: expected string or null');
  }
  if (typeof data['hasMore'] !== 'boolean') throw new Error('SyncDataPage.hasMore: expected boolean');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('SyncDataPage.data[]: expected object');
    if (typeof item['id'] !== 'string') throw new Error('SyncDataPage.data[].id: expected string');
    if (typeof item['messageId'] !== 'string') throw new Error('SyncDataPage.data[].messageId: expected string');
    if (typeof item['conversationId'] !== 'string') throw new Error('SyncDataPage.data[].conversationId: expected string');
    if (!isObject(item['encryptedPayload'])) throw new Error('SyncDataPage.data[].encryptedPayload: expected object');
  }
  return data;
}

export function validateSyncDataIdsPage(data: SyncDataIdsPage): SyncDataIdsPage {
  if (!isObject(data)) throw new Error('SyncDataIdsPage: expected object');
  if (!Array.isArray(data['data'])) throw new Error('SyncDataIdsPage.data: expected array');
  if (data['cursor'] !== null && typeof data['cursor'] !== 'string') {
    throw new Error('SyncDataIdsPage.cursor: expected string or null');
  }
  if (typeof data['hasMore'] !== 'boolean') throw new Error('SyncDataIdsPage.hasMore: expected boolean');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('SyncDataIdsPage.data[]: expected object');
    if (typeof item['messageId'] !== 'string') throw new Error('SyncDataIdsPage.data[].messageId: expected string');
    if (typeof item['createdAt'] !== 'number') throw new Error('SyncDataIdsPage.data[].createdAt: expected number');
  }
  return data;
}
