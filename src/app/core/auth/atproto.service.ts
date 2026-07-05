import { Injectable, inject } from '@angular/core';
import { AtprotoRepository } from './atproto.repository';

export interface AtprotoLoginResult {
  accessJwt: string;
  did:       string;
  handle:    string;
}

export interface DidDocument {
  service?: Array<{
    type:            string;
    serviceEndpoint: string;
  }>;
}

@Injectable({ providedIn: 'root' })
export class AtprotoService {
  private repo = inject(AtprotoRepository);

  async login(handle: string, password: string): Promise<AtprotoLoginResult> {
    return this.repo.login(handle, password);
  }

  async resolveDidToPds(did: string): Promise<string> {
    return this.repo.resolveDidToPds(did);
  }
}
