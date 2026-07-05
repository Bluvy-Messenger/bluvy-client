import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../infrastructure/api-client.service';
import type { UploadedKeyPackage, ConsumedKeyPackageResponse } from './mls.types';
import type { Paginated } from '../infrastructure/pagination.types';
import {
  validateConsumedKeyPackageResponse,
  validateEnsureGroupResponse,
  validateKeyPackagesForParticipantResponse,
  validateMissedCommitsResponse,
  validateMlsMyDevicesResponse,
  validatePendingWelcomesResponse,
} from './mls.validator';
import type {
  EnsureGroupResponse,
  MissedCommitsResponse,
  MlsMyDevicesResponse,
  PendingWelcomesResponse,
} from './mls.validator';

@Injectable({ providedIn: 'root' })
export class MlsRepository {
  private readonly apiClient = inject(ApiClientService);

  async ensureGroup(conversationId: string): Promise<EnsureGroupResponse> {
    const raw = await this.apiClient.post<EnsureGroupResponse>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/ensure-group`,
      {},
    );
    return validateEnsureGroupResponse(raw);
  }

  async consumeKeyPackage(participantDid: string): Promise<ConsumedKeyPackageResponse> {
    const raw = await this.apiClient.post<ConsumedKeyPackageResponse>(
      `/v1/key-packages/consume/${encodeURIComponent(participantDid)}`,
      {},
    );
    return validateConsumedKeyPackageResponse(raw);
  }

  async consumeOwnKeyPackage(deviceId: string): Promise<ConsumedKeyPackageResponse> {
    const raw = await this.apiClient.get<ConsumedKeyPackageResponse>(
      `/v1/key-packages/consume/mine/${encodeURIComponent(deviceId)}`,
    );
    return validateConsumedKeyPackageResponse(raw);
  }

  postWelcome(targetDeviceId: string, welcome: string, conversationId: string): Promise<unknown> {
    return this.apiClient.post('/v1/welcome', { targetDeviceId, welcome, conversationId });
  }

  async getPendingWelcomes(conversationId: string): Promise<PendingWelcomesResponse> {
    const raw = await this.apiClient.get<PendingWelcomesResponse>(
      '/v1/welcome/pending',
      { params: { conversationId } },
    );
    return validatePendingWelcomesResponse(raw);
  }

  async getMissedCommits(conversationId: string, afterEpoch: number): Promise<MissedCommitsResponse> {
    const raw = await this.apiClient.get<MissedCommitsResponse>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/mls-commits`,
      { params: { afterEpoch: String(afterEpoch) } },
    );
    return validateMissedCommitsResponse(raw);
  }

  ackWelcome(welcomeId: string): Promise<unknown> {
    return this.apiClient.post(`/v1/welcome/${encodeURIComponent(welcomeId)}/ack`, {});
  }

  async getKeyPackagesForParticipant(participantDid: string): Promise<Paginated<UploadedKeyPackage>> {
    const raw = await this.apiClient.get<Paginated<UploadedKeyPackage>>(
      `/v1/key-packages/${encodeURIComponent(participantDid)}`,
      { params: { limit: '20' } },
    );
    return validateKeyPackagesForParticipantResponse(raw);
  }

  postCommit(conversationId: string, commit: string, epoch: number): Promise<unknown> {
    return this.apiClient.post(
      `/v1/conversations/${encodeURIComponent(conversationId)}/mls-commit`,
      { commit, epoch },
    );
  }

  async getMyDevices(): Promise<MlsMyDevicesResponse> {
    const raw = await this.apiClient.get<MlsMyDevicesResponse>('/v1/devices/mine');
    return validateMlsMyDevicesResponse(raw);
  }
}
