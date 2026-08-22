import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonModal, ToastController } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { AuthService } from '../../core/auth/auth.service';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';


import { ROUTES } from '../../core/routes';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Browser } from '@capacitor/browser';
import { addIcons } from 'ionicons';
import {
  close, chatbubbleEllipsesOutline, linkOutline, shareSocialOutline,
  shieldCheckmarkOutline, fingerPrintOutline, openOutline, phonePortraitOutline,
  copyOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.page.html',
  styleUrls: ['./profile.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, IonModal, AvatarComponent, TranslatePipe],
})
export class ProfilePage {
  readonly authSvc = inject(AuthService);
  private router   = inject(Router);
  private toastCtrl = inject(ToastController);
  private i18n     = inject(TranslateService);

  bio = '';
  loadingBio = false;
  
  isInviteModalOpen = false;
  directInviteUrl = '';
  qrCodeUrl = '';

  constructor() {
    addIcons({
      close,
      chatbubbleEllipsesOutline,
      linkOutline,
      shareSocialOutline,
      shieldCheckmarkOutline,
      fingerPrintOutline,
      openOutline,
      phonePortraitOutline,
      copyOutline
    });
  }

  async ionViewWillEnter(): Promise<void> {
    const user = this.authSvc.currentUser();
    if (!user) return;

    // Always bluvy.app, even in dev: shared/scanned by other people's
    // devices and clients, which have no notion of "this dev server".
    this.directInviteUrl = `https://bluvy.app/message#${user.did}`;
    this.qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(this.directInviteUrl)}`;

    this.loadingBio = true;
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(user.did)}`);
      if (res.ok) {
        const data = await res.json();
        this.bio = data.description || '';
      }
    } catch (e) {
      console.warn('Failed to fetch profile description:', e);
    } finally {
      this.loadingBio = false;
    }
  }

  goBack(): void {
    void this.router.navigate([ROUTES.menu]);
  }

  async copyDirectLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.directInviteUrl);
      const toast = await this.toastCtrl.create({
        message: this.i18n.instant('contact_detail.link_copied'),
        duration: 3000,
        position: 'bottom',
        color: 'success'
      });
      await toast.present();
    } catch {
      // Ignored
    }
    this.isInviteModalOpen = false;
  }

  async shareQrCode(): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) {
        await Share.share({
          title: this.i18n.instant('landing.invite.preview.header'),
          text: this.i18n.instant('landing.invite.preview.badge'),
          url: this.directInviteUrl,
          dialogTitle: this.i18n.instant('landing.invite.preview.header')
        });
      } else if (typeof navigator.share === 'function') {
        await navigator.share({
          title: this.i18n.instant('landing.invite.preview.header'),
          text: this.i18n.instant('landing.invite.preview.badge'),
          url: this.directInviteUrl
        });
      } else {
        window.open(this.qrCodeUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // Ignored
    }
  }

  openInvite(): void {
    this.isInviteModalOpen = true;
  }

  async editOnBluesky(): Promise<void> {
    const handle = this.authSvc.currentUser()?.handle || '';
    const url = `https://bsky.app/profile/${handle}`;
    if (Capacitor.isNativePlatform()) {
      await Browser.open({ url });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  openDevices(): void {
    void this.router.navigate([ROUTES.security]);
  }

  async copyDid(): Promise<void> {
    const did = this.authSvc.currentUser()?.did;
    if (!did) return;
    try {
      await navigator.clipboard.writeText(did);
      const toast = await this.toastCtrl.create({
        message: 'DID copié !',
        duration: 2000,
        position: 'bottom',
        color: 'success'
      });
      await toast.present();
    } catch {
      // Ignored
    }
  }
}
