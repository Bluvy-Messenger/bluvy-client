import type { DeviceItem, RevokedDeviceItem, PendingProvisionItem } from './device.repository';
import type { StoredDeviceIdentity } from './device.types';
import { isObject } from '../infrastructure/validation.util';

export function validateStoredDeviceIdentity(data: StoredDeviceIdentity): StoredDeviceIdentity {
  if (!isObject(data)) throw new Error('StoredDeviceIdentity: expected object');
  if (typeof data['id'] !== 'string') throw new Error('StoredDeviceIdentity.id: expected string');
  if (typeof data['createdAt'] !== 'number') throw new Error('StoredDeviceIdentity.createdAt: expected number');
  return data;
}

export function validateDeviceItem(data: DeviceItem): DeviceItem {
  if (!isObject(data)) throw new Error('DeviceItem: expected object');
  if (typeof data['id'] !== 'string') throw new Error('DeviceItem.id: expected string');
  if (typeof data['name'] !== 'string') throw new Error('DeviceItem.name: expected string');
  if (typeof data['platform'] !== 'string') throw new Error('DeviceItem.platform: expected string');
  if (typeof data['lastSeen'] !== 'number') throw new Error('DeviceItem.lastSeen: expected number');
  if (typeof data['createdAt'] !== 'number') throw new Error('DeviceItem.createdAt: expected number');
  return data;
}

export function validateDeviceItemsResponse(data: { data: DeviceItem[] }): { data: DeviceItem[] } {
  if (!isObject(data)) throw new Error('DeviceItemsResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('DeviceItemsResponse.data: expected array');
  return { data: data['data'].map(validateDeviceItem) };
}

export function validateRevokedDeviceItem(data: RevokedDeviceItem): RevokedDeviceItem {
  if (!isObject(data)) throw new Error('RevokedDeviceItem: expected object');
  if (typeof data['id'] !== 'string') throw new Error('RevokedDeviceItem.id: expected string');
  if (typeof data['userDid'] !== 'string') throw new Error('RevokedDeviceItem.userDid: expected string');
  return data;
}

export function validateRevokedDeviceItemsResponse(data: { data: RevokedDeviceItem[] }): { data: RevokedDeviceItem[] } {
  if (!isObject(data)) throw new Error('RevokedDeviceItemsResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('RevokedDeviceItemsResponse.data: expected array');
  return { data: data['data'].map(validateRevokedDeviceItem) };
}

export function validatePendingProvisionItem(data: PendingProvisionItem): PendingProvisionItem {
  if (!isObject(data)) throw new Error('PendingProvisionItem: expected object');
  if (typeof data['deviceId'] !== 'string') throw new Error('PendingProvisionItem.deviceId: expected string');
  if (typeof data['conversationId'] !== 'string') throw new Error('PendingProvisionItem.conversationId: expected string');
  return data;
}

export function validatePendingProvisionItemsResponse(data: { data: PendingProvisionItem[] }): { data: PendingProvisionItem[] } {
  if (!isObject(data)) throw new Error('PendingProvisionItemsResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('PendingProvisionItemsResponse.data: expected array');
  return { data: data['data'].map(validatePendingProvisionItem) };
}
