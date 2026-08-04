import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

// Shared epochConflict$ event bus. Extracted so MlsMembershipService (which
// detects and reports 409 epoch conflicts from provisionDevice /
// reprovisionLostStateDevice / removeRevokedDeviceFromAllGroups) and
// MlsService (whose epochConflict$ property is the one MlsCoordinatorService
// subscribes to, per MlsCoordinatorBase's stable contract) can both reach the
// same Subject without depending on each other -- same "registered
// reference" motivation as MlsBackupRegistry (mls-backup-registry.service.ts).
@Injectable({ providedIn: 'root' })
export class MlsEpochConflictBus {
  readonly epochConflict$ = new Subject<{ conversationId: string }>();
}
