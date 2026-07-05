export interface UserProfile {
  did:         string;
  handle:      string;
  displayName: string | null;
  avatarUrl:   string | null;
}

export interface AuthResponse {
  accessToken:  string;
  refreshToken: string;
  user:         UserProfile;
  device: {
    id:       string;
    name:     string;
    platform: string;
  };
}

export interface AuthSessionResponse {
  user:   UserProfile;
  device: {
    id:       string;
    name:     string;
    platform: string;
  };
}

export interface RefreshResponse {
  accessToken:  string;
  refreshToken: string;
}
