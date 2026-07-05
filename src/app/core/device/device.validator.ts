import type { DeviceItem } from './device.repository';
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
