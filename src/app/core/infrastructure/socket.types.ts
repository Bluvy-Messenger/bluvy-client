export interface MessageNewPayload {
  id:             string;
  conversationId: string;
  senderDeviceId: string;
  senderDid:      string;
  ciphertext:     string;
  createdAt:      number;
}

export interface WelcomeNewPayload {
  id:             string;
  conversationId: string | null;
  welcome:        string;
  createdAt:      number;
}

export interface DeviceNewPayload {
  deviceId:   string;
  deviceName: string;
  platform:   string;
}

export interface MlsCommitPayload {
  conversationId: string;
  commit:         string;
  epoch:          number;
}

export type SendAck =
  | { ok: true;  message: MessageNewPayload }
  | { ok: false; code: string; message: string };

export type PresenceStatus = 'online' | 'offline';

export interface PresenceSnapshotPayload {
  statuses: { did: string; status: PresenceStatus }[];
}

export interface PresenceUpdatePayload {
  did:    string;
  status: PresenceStatus;
}

export interface TypingStartPayload { conversationId: string; senderDid: string; }
export interface TypingStopPayload  { conversationId: string; senderDid: string; }

export interface ConversationNewPayload {
  id:                   string;
  type:                 string;
  createdAt:            number;
  lastMessageAt:        number | null;
  lastMessageId:        string | null;
  lastMessageSenderDid: string | null;
  unreadCount:          number;
  participant: {
    did:         string;
    handle:      string;
    displayName: string | null;
    avatarUrl:   string | null;
  };
}

export interface ReceiptUpdatePayload {
  conversationId:    string;
  lastReadMessageId: string;
  readerDid:         string;
}

export interface ReceiptDeliveredPayload {
  conversationId: string;
  messageId:      string;
  deliveredTo:    string;
}
