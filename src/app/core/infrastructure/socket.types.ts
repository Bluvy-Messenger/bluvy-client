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
  deviceId:        string;
  deviceName:      string;
  platform:        string;
  // 'new': first-time device pairing (key-packages.routes.ts).
  // 'lost_state': nudge to re-provision a device that consumed a Welcome
  // before but has no local MLS state now (claimInitiatorSlot's lost-state
  // branch, see Phase 8b / AUDIT_02 Root Cause #3). Optional for backward
  // compatibility with an older backend that doesn't send it yet.
  reason?:         'new' | 'lost_state';
  // Only present for reason: 'lost_state'. Informational/logging only — the
  // client still sweeps all conversations, since local state loss is not
  // generally scoped to a single conversation.
  conversationId?: string;
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

// Emitted to every member's currently-connected devices when a conversation
// is recreated (Root Cause #3 fallback — see AUDIT_02/04/05, Phase 9).
export interface ConversationSupersededPayload {
  oldConversationId: string;
  newConversationId: string;
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

export interface MlsRefillKeyPackagesPayload {
  count: number;
}

export interface DeviceRevokedPayload {
  deviceId: string;
}
