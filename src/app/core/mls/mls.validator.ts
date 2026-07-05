import type { ConsumedKeyPackageResponse, UploadedKeyPackage } from './mls.types';
import type { Paginated } from '../infrastructure/pagination.types';
import { isObject } from '../infrastructure/validation.util';

export type EnsureGroupResponse = { role: 'initiator' | 'joiner' | 'already_initialized' };

export type PendingWelcomesResponse = {
  data: Array<{ id: string; conversationId: string | null; welcome: string; createdAt: number }>;
};

export type MissedCommitsResponse = {
  data: Array<{ id: string; conversationId: string; senderDeviceId: string; commit: string; epoch: number; createdAt: number }>;
};

export type MlsMyDevicesResponse = {
  data: Array<{ id: string; name: string; platform: string }>;
};

function isEnsureGroupRole(value: unknown): value is 'initiator' | 'joiner' | 'already_initialized' {
  return value === 'initiator' || value === 'joiner' || value === 'already_initialized';
}

export function validateEnsureGroupResponse(data: EnsureGroupResponse): EnsureGroupResponse {
  if (!isObject(data)) throw new Error('EnsureGroupResponse: expected object');
  if (!isEnsureGroupRole(data['role'])) throw new Error('EnsureGroupResponse.role: expected known role');
  return data;
}

export function validateConsumedKeyPackageResponse(data: ConsumedKeyPackageResponse): ConsumedKeyPackageResponse {
  if (!isObject(data)) throw new Error('ConsumedKeyPackageResponse: expected object');
  if (typeof data['keyPackage'] !== 'string') throw new Error('ConsumedKeyPackageResponse.keyPackage: expected string');
  if (typeof data['deviceId'] !== 'string') throw new Error('ConsumedKeyPackageResponse.deviceId: expected string');
  return data;
}

export function validatePendingWelcomesResponse(data: PendingWelcomesResponse): PendingWelcomesResponse {
  if (!isObject(data)) throw new Error('PendingWelcomesResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('PendingWelcomesResponse.data: expected array');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('PendingWelcomesResponse.data[]: expected object');
    if (typeof item['id'] !== 'string') throw new Error('PendingWelcomesResponse.data[].id: expected string');
    if (item['conversationId'] !== null && typeof item['conversationId'] !== 'string') {
      throw new Error('PendingWelcomesResponse.data[].conversationId: expected string or null');
    }
    if (typeof item['welcome'] !== 'string') throw new Error('PendingWelcomesResponse.data[].welcome: expected string');
    if (typeof item['createdAt'] !== 'number') throw new Error('PendingWelcomesResponse.data[].createdAt: expected number');
  }
  return data;
}

export function validateMissedCommitsResponse(data: MissedCommitsResponse): MissedCommitsResponse {
  if (!isObject(data)) throw new Error('MissedCommitsResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('MissedCommitsResponse.data: expected array');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('MissedCommitsResponse.data[]: expected object');
    if (typeof item['id'] !== 'string') throw new Error('MissedCommitsResponse.data[].id: expected string');
    if (typeof item['conversationId'] !== 'string') throw new Error('MissedCommitsResponse.data[].conversationId: expected string');
    if (typeof item['senderDeviceId'] !== 'string') throw new Error('MissedCommitsResponse.data[].senderDeviceId: expected string');
    if (typeof item['commit'] !== 'string') throw new Error('MissedCommitsResponse.data[].commit: expected string');
    if (typeof item['epoch'] !== 'number') throw new Error('MissedCommitsResponse.data[].epoch: expected number');
    if (typeof item['createdAt'] !== 'number') throw new Error('MissedCommitsResponse.data[].createdAt: expected number');
  }
  return data;
}

export function validateKeyPackagesForParticipantResponse(data: Paginated<UploadedKeyPackage>): Paginated<UploadedKeyPackage> {
  if (!isObject(data)) throw new Error('KeyPackagesForParticipantResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('KeyPackagesForParticipantResponse.data: expected array');
  if (data['cursor'] !== null && typeof data['cursor'] !== 'string') {
    throw new Error('KeyPackagesForParticipantResponse.cursor: expected string or null');
  }
  if (typeof data['hasMore'] !== 'boolean') throw new Error('KeyPackagesForParticipantResponse.hasMore: expected boolean');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('KeyPackagesForParticipantResponse.data[]: expected object');
    if (typeof item['id'] !== 'string') throw new Error('KeyPackagesForParticipantResponse.data[].id: expected string');
    if (typeof item['deviceId'] !== 'string') throw new Error('KeyPackagesForParticipantResponse.data[].deviceId: expected string');
    if (typeof item['keyPackage'] !== 'string') throw new Error('KeyPackagesForParticipantResponse.data[].keyPackage: expected string');
    if (typeof item['createdAt'] !== 'number') throw new Error('KeyPackagesForParticipantResponse.data[].createdAt: expected number');
  }
  return data;
}

export function validateMlsMyDevicesResponse(data: MlsMyDevicesResponse): MlsMyDevicesResponse {
  if (!isObject(data)) throw new Error('MlsMyDevicesResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('MlsMyDevicesResponse.data: expected array');
  for (const item of data['data']) {
    if (!isObject(item)) throw new Error('MlsMyDevicesResponse.data[]: expected object');
    if (typeof item['id'] !== 'string') throw new Error('MlsMyDevicesResponse.data[].id: expected string');
    if (typeof item['name'] !== 'string') throw new Error('MlsMyDevicesResponse.data[].name: expected string');
    if (typeof item['platform'] !== 'string') throw new Error('MlsMyDevicesResponse.data[].platform: expected string');
  }
  return data;
}
