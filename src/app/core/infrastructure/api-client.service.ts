import { Injectable, inject } from '@angular/core';
import {
  HttpBackend,
  HttpClient,
  HttpHeaders,
  HttpParams,
  HttpErrorResponse,
} from '@angular/common/http';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Router } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TokenRepository } from './token.repository';
import { ROUTES } from '../routes';

export interface ApiHttpOptions {
  headers?:  Record<string, string>;
  params?:   Record<string, string>;
  skipAuth?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ApiClientService {
  private readonly http   = new HttpClient(inject(HttpBackend));
  private readonly tokens = inject(TokenRepository);
  private readonly router = inject(Router);

  private refreshing: Promise<boolean> | null = null;

  async get<T = unknown>(path: string, options?: ApiHttpOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T = unknown>(path: string, body?: unknown, options?: ApiHttpOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  async put<T = unknown>(path: string, body?: unknown, options?: ApiHttpOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  async delete<T = unknown>(path: string, options?: ApiHttpOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  // Fetches a binary response (e.g. a proxied image) as a Blob, with the same
  // auth-header handling as the JSON methods. A plain <img src> can't attach
  // a Bearer token, so binary resources behind authenticate must go through here.
  async getBlob(path: string, options?: ApiHttpOptions): Promise<Blob> {
    const url     = this.buildUrl(path);
    const headers = await this.buildHeaders(options);
    return Capacitor.isNativePlatform()
      ? this.sendNativeBlob(url, headers, options?.params)
      : this.sendWebBlob(url, headers, options?.params);
  }

  private async request<T>(
    method:   string,
    path:     string,
    body?:    unknown,
    options?: ApiHttpOptions,
  ): Promise<T> {
    const url     = this.buildUrl(path);
    const headers = await this.buildHeaders(options);

    try {
      return await this.send<T>(method, url, body, headers, options?.params);
    } catch (err) {
      if (options?.skipAuth || !this.is401(err)) throw err;

      const refreshed = await this.ensureRefresh();
      if (!refreshed) throw err;

      const retryHeaders = await this.buildHeaders(options);
      return this.send<T>(method, url, body, retryHeaders, options?.params);
    }
  }

  private buildUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return `${environment.apiUrl}${path}`;
  }

  private async buildHeaders(options?: ApiHttpOptions): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...options?.headers };
    if (!options?.skipAuth) {
      const token = await this.tokens.getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private send<T>(
    method:  string,
    url:     string,
    body:    unknown,
    headers: Record<string, string>,
    params?: Record<string, string>,
  ): Promise<T> {
    return Capacitor.isNativePlatform()
      ? this.sendNative<T>(method, url, body, headers, params)
      : this.sendWeb<T>(method, url, body, headers, params);
  }

  private sendWeb<T>(
    method:  string,
    url:     string,
    body:    unknown,
    headers: Record<string, string>,
    params?: Record<string, string>,
  ): Promise<T> {
    const httpHeaders = new HttpHeaders(
      body !== undefined
        ? { 'Content-Type': 'application/json', ...headers }
        : headers,
    );
    let httpParams = new HttpParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => { httpParams = httpParams.set(k, v); });
    }
    const opts = { headers: httpHeaders, params: httpParams };

    switch (method) {
      case 'GET':    return firstValueFrom(this.http.get<T>(url, opts).pipe(timeout(15_000)));
      case 'POST':   return firstValueFrom(this.http.post<T>(url, body ?? null, opts).pipe(timeout(15_000)));
      case 'PUT':    return firstValueFrom(this.http.put<T>(url, body ?? null, opts).pipe(timeout(15_000)));
      case 'DELETE': return firstValueFrom(this.http.delete<T>(url, opts).pipe(timeout(15_000)));
      default:       throw new Error(`Unsupported HTTP method: ${method}`);
    }
  }

  private async sendNative<T>(
    method:  string,
    url:     string,
    body:    unknown,
    headers: Record<string, string>,
    params?: Record<string, string>,
  ): Promise<T> {
    const response = await CapacitorHttp.request({
      method,
      url,
      data:    body,
      headers: body !== undefined
        ? { 'Content-Type': 'application/json', ...headers }
        : headers,
      params,
      connectTimeout: 15_000,
      readTimeout:    15_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new HttpErrorResponse({ url, status: response.status, error: response.data });
    }
    return response.data as T;
  }

  private sendWebBlob(
    url:     string,
    headers: Record<string, string>,
    params?: Record<string, string>,
  ): Promise<Blob> {
    const httpHeaders = new HttpHeaders(headers);
    let httpParams = new HttpParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => { httpParams = httpParams.set(k, v); });
    }
    return firstValueFrom(
      this.http
        .get(url, { headers: httpHeaders, params: httpParams, responseType: 'blob' })
        .pipe(timeout(15_000)),
    );
  }

  private async sendNativeBlob(
    url:     string,
    headers: Record<string, string>,
    params?: Record<string, string>,
  ): Promise<Blob> {
    const response = await CapacitorHttp.request({
      method:         'GET',
      url,
      headers,
      params,
      responseType:   'blob',
      connectTimeout: 15_000,
      readTimeout:    15_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new HttpErrorResponse({ url, status: response.status, error: response.data });
    }
    // Native layer base64-encodes binary responses over the JSON bridge.
    const contentType = response.headers['Content-Type'] ?? response.headers['content-type'] ?? 'application/octet-stream';
    const binary = atob(response.data as string);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType });
  }

  private is401(err: unknown): boolean {
    return err instanceof HttpErrorResponse && err.status === 401;
  }

  private ensureRefresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = await this.tokens.getRefreshToken();
    if (!refreshToken) {
      await this.tokens.clearTokens();
      await this.router.navigate([ROUTES.login]);
      return false;
    }
    try {
      const resp = await this.send<{ accessToken: string; refreshToken: string }>(
        'POST',
        this.buildUrl('/v1/auth/refresh'),
        { refreshToken },
        { 'Content-Type': 'application/json' },
      );
      await this.tokens.setAccessToken(resp.accessToken);
      await this.tokens.setRefreshToken(resp.refreshToken);
      return true;
    } catch {
      await this.tokens.clearTokens();
      await this.router.navigate([ROUTES.login]);
      return false;
    }
  }
}
