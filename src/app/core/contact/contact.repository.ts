import { Injectable, inject } from '@angular/core';
import type { ContactResolveResponse } from './contact.types';
import { validateContactResolveResponse } from './contact.validator';
import { ApiClientService } from '../infrastructure/api-client.service';

@Injectable({ providedIn: 'root' })
export class ContactRepository {
  private apiClient = inject(ApiClientService);

  async resolve(dids: string[]): Promise<ContactResolveResponse> {
    const raw = await this.apiClient.post<ContactResolveResponse>('/v1/contacts/resolve', { dids });
    return validateContactResolveResponse(raw);
  }
}
