import { Injectable, inject } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private http = inject(HttpClient);

  /**
   * Sanitizes a raw application route/URL by replacing sensitive dynamic route
   * parameters (DIDs, conversation IDs, UUIDs) with generic placeholders (:masked).
   * Ensures no personal identifiers, DIDs, or conversation IDs leak to Matomo.
   */
  sanitizeUrl(rawUrl: string): string {
    const base = environment.analytics?.canonicalDomain ?? 'https://bluvy.app';
    let cleanPath = rawUrl || '/';

    // Remove query parameters or fragments if any
    cleanPath = cleanPath.split('?')[0].split('#')[0];

    // Mask AT Protocol DIDs (e.g., did:plc:123456789 or did:web:example.com)
    cleanPath = cleanPath.replace(/did:[a-z0-9]+:[a-zA-Z0-9._-]+/gi, ':masked');

    // Mask conversation IDs (e.g., /conversations/abc-123-xyz)
    cleanPath = cleanPath.replace(/\/conversations\/[a-zA-Z0-9._-]+/gi, '/conversations/:masked');

    // Mask contact DIDs (e.g., /contacts/did:plc:...)
    cleanPath = cleanPath.replace(/\/contacts\/[a-zA-Z0-9._:-]+/gi, '/contacts/:masked');

    // Normalize double slashes
    cleanPath = cleanPath.replace(/\/+/g, '/');

    return `${base}${cleanPath}`;
  }

  private getOrCreateVisitorId(): string {
    try {
      let id = localStorage.getItem('bluvy_analytics_vid');
      if (!id || id.length !== 16) {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('bluvy_analytics_vid', id);
      }
      return id;
    } catch {
      return '1234567890abcdef';
    }
  }

  /**
   * Sends a page view tracking request to Matomo via HTTP.
   */
  trackPageView(rawUrl: string, title?: string): void {
    if (!environment.analytics?.enabled) return;

    const sanitizedUrl = this.sanitizeUrl(rawUrl);
    const params = new URLSearchParams({
      idsite: String(environment.analytics.siteId),
      rec: '1',
      apiv: '1',
      _id: this.getOrCreateVisitorId(),
      url: sanitizedUrl,
      rand: String(Math.floor(Math.random() * 1000000000)),
      send_image: '1',
    });

    if (title) {
      params.set('action_name', title);
    }
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      params.set('ua', navigator.userAgent);
    }

    void this.sendMatomoRequest(params);
  }

  /**
   * Sends a custom action event to Matomo via HTTP.
   */
  trackEvent(category: string, action: string, name?: string, value?: number): void {
    if (!environment.analytics?.enabled) return;

    const base = environment.analytics?.canonicalDomain ?? 'https://bluvy.app';
    const params = new URLSearchParams({
      idsite: String(environment.analytics.siteId),
      rec: '1',
      apiv: '1',
      _id: this.getOrCreateVisitorId(),
      url: `${base}/event`,
      e_c: category,
      e_a: action,
      rand: String(Math.floor(Math.random() * 1000000000)),
      send_image: '1',
    });

    if (name) {
      params.set('e_n', name);
    }
    if (typeof value === 'number' && !isNaN(value)) {
      params.set('e_v', String(value));
    }
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      params.set('ua', navigator.userAgent);
    }

    void this.sendMatomoRequest(params);
  }

  /**
   * Sends the tracking payload to Matomo using CapacitorHttp on native platforms
   * (iOS/Android) or Angular HttpClient on web.
   */
  private async sendMatomoRequest(params: URLSearchParams): Promise<void> {
    const endpoint = environment.analytics?.matomoEndpoint;
    if (!endpoint) return;

    try {
      const fullUrl = `${endpoint}?${params.toString()}`;

      if (Capacitor.isNativePlatform()) {
        await CapacitorHttp.request({
          method: 'GET',
          url: fullUrl,
        });
      } else {
        // Angular HttpClient requires .subscribe() to trigger the HTTP execution
        this.http.get(fullUrl, { responseType: 'text' }).subscribe({
          error: () => {},
        });
      }
    } catch {
      // Silently swallow analytics errors so they never disrupt core app flows.
    }
  }
}
