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
      await this.router.navigate(['/login']);
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
      await this.router.navigate(['/login']);
      return false;
    }
  }
}
