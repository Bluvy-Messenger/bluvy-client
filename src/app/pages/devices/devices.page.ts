import { Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { DeviceRepository } from '../../core/device/device.repository';
import { AuthService } from '../../core/auth/auth.service';
import type { DeviceItem } from '../../core/device/device.repository';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';

@Component({
  selector: 'app-devices',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './devices.page.html',
  styleUrls: ['./devices.page.scss'],
})
export class DevicesPage implements OnInit {
  private deviceRepo = inject(DeviceRepository);
  private authSvc    = inject(AuthService);
  private location   = inject(Location);
  private i18n       = inject(TranslationService);

  @Input()  embedded     = false;
  @Output() navigateBack = new EventEmitter<void>();

  devices:         DeviceItem[] = [];
  currentDeviceId  = '';
  loading          = false;
  error            = '';
  revokingId       = '';
  confirmRevokeId  = '';

  async ngOnInit(): Promise<void> {
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
      this.error = this.i18n.t('devices.error.load');
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
    } catch {
      this.error = this.i18n.t('devices.error.revoke');
    } finally {
      this.revokingId = '';
    }
  }

  goBack(): void {
    if (this.embedded) { this.navigateBack.emit(); return; }
    this.location.back();
  }

  platformIcon(platform: string): string {
    if (platform === 'android' || platform === 'ios') return 'phone-portrait-outline';
    return 'laptop-outline';
  }

  formatLastSeen(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000)           return this.i18n.t('devices.just_now');
    if (diff < 3_600_000)        return this.i18n.t('devices.minutes_ago', { n: Math.floor(diff / 60_000) });
    if (diff < 86_400_000)       return this.i18n.t('devices.hours_ago',   { n: Math.floor(diff / 3_600_000) });
    if (diff < 7 * 86_400_000)   return this.i18n.t('devices.days_ago',    { n: Math.floor(diff / 86_400_000) });
    return new Date(ts).toLocaleDateString(this.i18n.locale === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  formatCreatedAt(ts: number): string {
    return new Date(ts).toLocaleDateString(this.i18n.locale === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}
