import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { IonContent, IonIcon, IonModal, IonCheckbox } from '@ionic/angular/standalone';
import { DeviceRepository } from '../../core/device/device.repository';
import { AuthService } from '../../core/auth/auth.service';
import type { DeviceItem } from '../../core/device/device.repository';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';


import { SyncService } from '../../core/sync/sync.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-devices',
  standalone: true,
  imports: [IonContent, IonIcon, IonModal, IonCheckbox, FormsModule, TranslatePipe],
  templateUrl: './devices.page.html',
  styleUrls: ['./devices.page.scss'],
})
export class DevicesPage {
  private deviceRepo = inject(DeviceRepository);
  private authSvc    = inject(AuthService);
  private syncSvc    = inject(SyncService);
  private router     = inject(Router);
  private i18n       = inject(TranslateService);

  devices:         DeviceItem[] = [];
  currentDeviceId  = '';
  loading          = false;
  error            = '';
  revokingId       = '';
  confirmRevokeId  = '';
  revokingAll      = false;
  confirmRevokeAll = false;

  // ── MBK rotation (after a revoke succeeds) ─────────────────────────────────
  // A revoked device may already have extracted the MBK -- rotating it so
  // that device loses read access to future (and, once the background
  // rebuild finishes, past) backups. See docs/CRYPTO.md.
  rotationModalOpen  = false;
  rotationStep        = 'pin' as 'pin' | 'key';
  rotationPin         = '';
  rotationWorking      = false;
  rotationError        = '';
  newRecoveryKey       = '';
  newRecoveryChunks    = [] as string[];
  rotationAcknowledged = false;

  async ionViewWillEnter(): Promise<void> {
    this.currentDeviceId = this.authSvc.currentDevice()?.id ?? '';
    await this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error   = '';
    try {
      const result = await this.deviceRepo.getMyDevices();
      this.devices = result.data.sort((a, b) => {
        if (a.id === this.currentDeviceId) return -1;
        if (b.id === this.currentDeviceId) return 1;
        return b.lastSeen - a.lastSeen;
      });
    } catch {
      this.error = this.i18n.instant('devices.error.load');
    } finally {
      this.loading = false;
    }
  }

  askConfirm(deviceId: string): void {
    this.confirmRevokeId = deviceId;
  }

  cancelConfirm(): void {
    this.confirmRevokeId = '';
  }

  async revoke(device: DeviceItem): Promise<void> {
    this.confirmRevokeId = '';
    this.revokingId      = device.id;
    this.error           = '';
    try {
      await this.deviceRepo.revokeDevice(device.id);
      this.devices = this.devices.filter(d => d.id !== device.id);
      this.openRotationModal();
    } catch {
      this.error = this.i18n.instant('devices.error.revoke');
    } finally {
      this.revokingId = '';
    }
  }

  askConfirmAll(): void {
    this.confirmRevokeAll = true;
  }

  cancelConfirmAll(): void {
    this.confirmRevokeAll = false;
  }

  async revokeAll(): Promise<void> {
    this.confirmRevokeAll = false;
    this.revokingAll      = true;
    this.error            = '';
    try {
      await this.deviceRepo.revokeAllDevices();
      this.devices = this.devices.filter(d => d.id === this.currentDeviceId);
      this.openRotationModal();
    } catch {
      this.error = this.i18n.instant('devices.error.revoke_all');
    } finally {
      this.revokingAll = false;
    }
  }

  // ── MBK rotation ───────────────────────────────────────────────────────────

  private openRotationModal(): void {
    this.rotationStep         = 'pin';
    this.rotationPin          = '';
    this.rotationError        = '';
    this.rotationAcknowledged = false;
    this.rotationModalOpen    = true;
  }

  // The device is already revoked by this point (see revoke()/revokeAll()) --
  // rotation just closes the remaining window where an already-extracted MBK
  // stays useful. Cancelling here leaves the revocation itself intact, just
  // without rotation; no retry is offered, matching the plan's accepted v1 scope.
  cancelRotation(): void {
    this.rotationModalOpen = false;
    this.rotationPin       = '';
  }

  async confirmRotationPin(): Promise<void> {
    this.rotationError   = '';
    this.rotationWorking = true;
    try {
      const result           = await this.syncSvc.rotateMbk(this.rotationPin);
      this.newRecoveryKey    = result.recoveryKey;
      this.newRecoveryChunks = this.chunk(result.recoveryKey, 8);
      this.rotationPin       = '';
      this.rotationStep      = 'key';
    } catch (err) {
      this.rotationError = err instanceof Error && err.message === 'Incorrect PIN'
        ? this.i18n.instant('devices.rotation.error.wrong_pin')
        : this.i18n.instant('devices.rotation.error.generic');
    } finally {
      this.rotationWorking = false;
    }
  }

  async copyNewRecoveryKey(): Promise<void> {
    try { await navigator.clipboard.writeText(this.newRecoveryKey); } catch { /* ignore */ }
  }

  finishRotation(): void {
    this.rotationModalOpen = false;
  }

  private chunk(s: string, n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  }

  goBack(): void {
    void this.router.navigate([ROUTES.security]);
  }

  platformIcon(platform: string): string {
    if (platform === 'android' || platform === 'ios') return 'phone-portrait-outline';
    return 'laptop-outline';
  }

  formatLastSeen(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000)           return this.i18n.instant('devices.just_now');
    if (diff < 3_600_000)        return this.i18n.instant('devices.minutes_ago', { n: Math.floor(diff / 60_000) });
    if (diff < 86_400_000)       return this.i18n.instant('devices.hours_ago',   { n: Math.floor(diff / 3_600_000) });
    if (diff < 7 * 86_400_000)   return this.i18n.instant('devices.days_ago',    { n: Math.floor(diff / 86_400_000) });
    return new Date(ts).toLocaleDateString(this.i18n.currentLang() === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  formatCreatedAt(ts: number): string {
    return new Date(ts).toLocaleDateString(this.i18n.currentLang() === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}
