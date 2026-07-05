import type { ConversationNewPayload, DeviceNewPayload, MessageNewPayload, MlsCommitPayload, PresenceSnapshotPayload, PresenceStatus, PresenceUpdatePayload, ReceiptDeliveredPayload, ReceiptUpdatePayload, TypingStartPayload, TypingStopPayload, WelcomeNewPayload } from './socket.types';
import { isObject } from './validation.util';

export function validateMessageNewPayload(data: MessageNewPayload): MessageNewPayload {
  if (!isObject(data)) throw new Error('MessageNewPayload: expected object');
  if (typeof data['id'] !== 'string') throw new Error('MessageNewPayload.id: expected string');
  if (typeof data['conversationId'] !== 'string') throw new Error('MessageNewPayload.conversationId: expected string');
  if (typeof data['senderDeviceId'] !== 'string') throw new Error('MessageNewPayload.senderDeviceId: expected string');
  if (typeof data['senderDid'] !== 'string') throw new Error('MessageNewPayload.senderDid: expected string');
  if (typeof data['ciphertext'] !== 'string') throw new Error('MessageNewPayload.ciphertext: expected string');
  if (typeof data['createdAt'] !== 'number') throw new Error('MessageNewPayload.createdAt: expected number');
  return data;
}

export function validateWelcomeNewPayload(data: WelcomeNewPayload): WelcomeNewPayload {
  if (!isObject(data)) throw new Error('WelcomeNewPayload: expected object');
  if (typeof data['id'] !== 'string') throw new Error('WelcomeNewPayload.id: expected string');
  if (data['conversationId'] !== null && typeof data['conversationId'] !== 'string') {
    throw new Error('WelcomeNewPayload.conversationId: expected string or null');
  }
  if (typeof data['welcome'] !== 'string') throw new Error('WelcomeNewPayload.welcome: expected string');
  if (typeof data['createdAt'] !== 'number') throw new Error('WelcomeNewPayload.createdAt: expected number');
  return data;
}

export function validateDeviceNewPayload(data: DeviceNewPayload): DeviceNewPayload {
  if (!isObject(data)) throw new Error('DeviceNewPayload: expected object');
  if (typeof data['deviceId'] !== 'string') throw new Error('DeviceNewPayload.deviceId: expected string');
  if (typeof data['deviceName'] !== 'string') throw new Error('DeviceNewPayload.deviceName: expected string');
  if (typeof data['platform'] !== 'string') throw new Error('DeviceNewPayload.platform: expected string');
  return data;
}

export function validateMlsCommitPayload(data: MlsCommitPayload): MlsCommitPayload {
  if (!isObject(data)) throw new Error('MlsCommitPayload: expected object');
  if (typeof data['conversationId'] !== 'string') throw new Error('MlsCommitPayload.conversationId: expected string');
  if (typeof data['commit'] !== 'string') throw new Error('MlsCommitPayload.commit: expected string');
  if (typeof data['epoch'] !== 'number') throw new Error('MlsCommitPayload.epoch: expected number');
  return data;
}

function isPresenceStatus(value: unknown): value is PresenceStatus {
  return value === 'online' || value === 'offline';
}

export function validatePresenceSnapshotPayload(data: PresenceSnapshotPayload): PresenceSnapshotPayload {
  if (!isObject(data)) throw new Error('PresenceSnapshotPayload: expected object');
  if (!Array.isArray(data['statuses'])) throw new Error('PresenceSnapshotPayload.statuses: expected array');
  for (const item of data['statuses']) {
    if (!isObject(item)) throw new Error('PresenceSnapshotPayload.statuses[]: expected object');
    if (typeof item['did'] !== 'string') throw new Error('PresenceSnapshotPayload.statuses[].did: expected string');
    if (!isPresenceStatus(item['status'])) throw new Error('PresenceSnapshotPayload.statuses[].status: expected PresenceStatus');
  }
  return data;
}

export function validatePresenceUpdatePayload(data: PresenceUpdatePayload): PresenceUpdatePayload {
  if (!isObject(data)) throw new Error('PresenceUpdatePayload: expected object');
  if (typeof data['did'] !== 'string') throw new Error('PresenceUpdatePayload.did: expected string');
  if (!isPresenceStatus(data['status'])) throw new Error('PresenceUpdatePayload.status: expected PresenceStatus');
  return data;
}

export function validateTypingStartPayload(data: TypingStartPayload): TypingStartPayload {
  if (!isObject(data)) throw new Error('TypingStartPayload: expected object');
  if (typeof data['conversationId'] !== 'string') throw new Error('TypingStartPayload.conversationId: expected string');
  if (typeof data['senderDid'] !== 'string') throw new Error('TypingStartPayload.senderDid: expected string');
  return data;
}

export function validateTypingStopPayload(data: TypingStopPayload): TypingStopPayload {
  if (!isObject(data)) throw new Error('TypingStopPayload: expected object');
  if (typeof data['conversationId'] !== 'string') throw new Error('TypingStopPayload.conversationId: expected string');
  if (typeof data['senderDid'] !== 'string') throw new Error('TypingStopPayload.senderDid: expected string');
  return data;
}

export function validateReceiptUpdatePayload(data: ReceiptUpdatePayload): ReceiptUpdatePayload {
  if (!isObject(data)) throw new Error('ReceiptUpdatePayload: expected object');
  if (typeof data['conversationId'] !== 'string') throw new Error('ReceiptUpdatePayload.conversationId: expected string');
  if (typeof data['lastReadMessageId'] !== 'string') throw new Error('ReceiptUpdatePayload.lastReadMessageId: expected string');
  if (typeof data['readerDid'] !== 'string') throw new Error('ReceiptUpdatePayload.readerDid: expected string');
  return data;
}

export function validateReceiptDeliveredPayload(data: ReceiptDeliveredPayload): ReceiptDeliveredPayload {
  if (!isObject(data)) throw new Error('ReceiptDeliveredPayload: expected object');
  if (typeof data['conversationId'] !== 'string') throw new Error('ReceiptDeliveredPayload.conversationId: expected string');
  if (typeof data['messageId']      !== 'string') throw new Error('ReceiptDeliveredPayload.messageId: expected string');
  if (typeof data['deliveredTo']    !== 'string') throw new Error('ReceiptDeliveredPayload.deliveredTo: expected string');
  return data;
}

export function validateConversationNewPayload(data: ConversationNewPayload): ConversationNewPayload {
  if (!isObject(data)) throw new Error('ConversationNewPayload: expected object');
  if (typeof data['id'] !== 'string') throw new Error('ConversationNewPayload.id: expected string');
  if (typeof data['type'] !== 'string') throw new Error('ConversationNewPayload.type: expected string');
  if (typeof data['createdAt'] !== 'number') throw new Error('ConversationNewPayload.createdAt: expected number');
  if (!isObject(data['participant'])) throw new Error('ConversationNewPayload.participant: expected object');
  const p = data['participant'];
  if (typeof p['did'] !== 'string') throw new Error('ConversationNewPayload.participant.did: expected string');
  if (typeof p['handle'] !== 'string') throw new Error('ConversationNewPayload.participant.handle: expected string');
  return data;
}
