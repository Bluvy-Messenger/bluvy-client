// A mutual follower with a confirmed Bluvy account
export interface Contact {
  did:         string;
  handle:      string;
  displayName: string | null;
  avatarUrl:   string | null;
}

// Raw profile fetched from the Bluesky public social graph
export interface BlueskyProfile {
  did:         string;
  handle:      string;
  displayName: string | null;
  avatarUrl:   string | null;
}

// Full result of one contacts sync
export interface ContactSyncResult {
  bluvyContacts:   Contact[];         // mutual followers with Bluvy account
  blueskyContacts: BlueskyProfile[];  // mutual followers without Bluvy account
  syncedAt:        number;
}

// Response from POST /v1/contacts/resolve
export interface ContactResolveResponse {
  data: Contact[];
}
