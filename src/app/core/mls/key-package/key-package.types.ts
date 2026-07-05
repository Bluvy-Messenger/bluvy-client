export interface KeyPackageCountResponse {
  count:       number;
  target:      number;
  needsRefill: boolean;
}

export type KeyPackagePoolStatus = 'idle' | 'checking' | 'refilling' | 'error';
