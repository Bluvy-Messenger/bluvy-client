import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { BrowserOAuthClient, OAuthSession } from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';
import { environment } from '../../../environments/environment';
import { capacitorOAuthFetch } from './oauth-fetch.adapter';

let _client: BrowserOAuthClient | null = null;

// getServiceAuth (called from getServiceAuthToken below) requires this exact
// rpc scope to be granted — AT Protocol OAuth requires clients to declare in
// advance which `aud`/`lxm` combinations they may mint service-auth tokens
// for. aud/lxm here must match what getServiceAuthToken() is called with in
// auth.service.ts, and this same scope must be declared in the client's
// metadata (client-metadata.json in prod; the loopback client_id's own
// `scope` query param in dev — see resolveClientId()).
const SERVICE_AUTH_LXM = 'chat.bluvy.auth.login';
const OAUTH_SCOPE = `atproto transition:generic rpc:${SERVICE_AUTH_LXM}?aud=${environment.oauthServiceDid}`;

@Injectable({ providedIn: 'root' })
export class OAuthService {
  private _session: OAuthSession | null = null;

  async getClient(): Promise<BrowserOAuthClient> {
    if (!_client) {
      _client = await BrowserOAuthClient.load({
        clientId:       this.resolveClientId(),
        handleResolver: 'https://api.bsky.app',
        fetch:          capacitorOAuthFetch,
      });
    }
    return _client;
  }

  /**
   * Called once at app startup (via APP_INITIALIZER, before routing).
   * Handles both:
   *   - Dev loopback: query/hash params at root (127.0.0.1:PORT)
   *   - Prod redirect: query params (?code=…) at /oauth/callback
   * Stores the resulting session so components can consume it without
   * re-processing the code (which would fail — codes are single-use).
   *
   * Skips processing when hostname is 'localhost': the loopback client ID
   * encodes 127.0.0.1 as the redirect target, so the PDS will send the
   * callback there — not to localhost. Calling init() at localhost would
   * trigger fixLocation() (a library redirect to 127.0.0.1) which we don't
   * want before the user has even started the OAuth flow.
   */
  async tryHandleInit(): Promise<OAuthSession | null> {
    if (
      !environment.production &&
      typeof window !== 'undefined' &&
      window.location.hostname === 'localhost'
    ) {
      return null;
    }

    try {
      const client = await this.getClient();
      const result = await client.init();
      if (result) {
        this._session = result.session;
        return result.session;
      }
    } catch {
      // No callback params and no stored session — normal on first launch.
    }
    return null;
  }

  /**
   * Builds the OAuth client_id appropriate for the current environment.
   *
   * Production: returns the HTTPS metadata URL from environment config
   * (client-metadata.json — must declare the same `scope`, see OAUTH_SCOPE).
   *
   * Development (loopback): per the AT Protocol spec's "Localhost Client
   * Development" exception, a loopback client's virtual metadata document is
   * built entirely from query parameters on the client_id URL itself — NOT
   * from options passed to signInRedirect()/authorize() at request time.
   * `scope` defaults to bare `atproto` if omitted from the client_id, so any
   * broader scope (transition:generic, rpc:...) MUST be declared here too,
   * or the authorization server rejects it with invalid_scope even if the
   * same scope is also passed via AuthorizeOptions.
   *
   * Encoding the current port in redirect_uri ensures the library generates
   *   redirect_uri = http://127.0.0.1:PORT/
   * instead of the hardcoded default http://127.0.0.1/ (port 80).
   * Without this, the PDS would redirect to port 80 where nothing listens.
   */
  private resolveClientId(): string {
    if (environment.production) return environment.oauthClientId;

    const port = typeof window !== 'undefined' ? window.location.port : '';
    const redirectUri = `http://127.0.0.1${port ? ':' + port : ''}/`;
    const params = new URLSearchParams({ redirect_uri: redirectUri, scope: OAUTH_SCOPE });
    return `http://localhost?${params.toString()}`;
  }

  /**
   * Tries to restore an existing OAuth session from local storage only.
   * Does NOT process callback params — use tryHandleInit() for that.
   */
  async tryRestore(): Promise<OAuthSession | null> {
    try {
      const client = await this.getClient();
      const result = await client.initRestore();
      if (result) {
        this._session = result.session;
        return result.session;
      }
    } catch {
      // No stored session — normal on first launch.
    }
    return null;
  }

  /**
   * Starts the OAuth login flow.
   * - Web: redirects the page to the PDS (returns never).
   * - Native: opens a Custom Tab; resolves when the App Link callback arrives.
   */
  async signIn(handle: string): Promise<void> {
    const client = await this.getClient();

    if (Capacitor.isNativePlatform()) {
      await this.signInNative(client, handle);
    } else {
      await client.signInRedirect(handle, { scope: OAUTH_SCOPE });
    }
  }

  /**
   * Processes the OAuth callback params (code, state, iss).
   * Call this from the /oauth/callback route after a web redirect,
   * or indirectly via signIn() on native.
   */
  async handleCallback(params: URLSearchParams): Promise<OAuthSession> {
    const client = await this.getClient();
    // redirect_uri is stored in the OAuth state from the authorize step;
    // we don't need to pass it again here.
    const { session } = await client.initCallback(params);
    this._session = session;
    return session;
  }

  /**
   * Returns the raw OAuth access token.
   * OAuthSession.getTokenSet() is protected at compile time but accessible at runtime —
   * used only to forward the token to the SkyChat backend for verification.
   */
  async getAccessToken(session: OAuthSession): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenSet = await (session as any)['getTokenSet']('auto') as { access_token: string };
    return tokenSet.access_token;
  }

  /**
   * Mints a short-lived AT Protocol service-auth token (com.atproto.server.getServiceAuth),
   * scoped to `aud` (our backend's service identifier) and `lxm` (this exact purpose) —
   * both must match the `rpc:{lxm}?aud={aud}` scope declared in OAUTH_SCOPE above, which
   * was granted at authorization time.
   *
   * Unlike the raw OAuth access token (DPoP-bound, meant only for the PDS's own XRPC
   * calls), this token is signed with the account's actual repo/rotation key and is
   * independently verifiable by any third party via the DID document — no DPoP, no
   * OAuth JWKS needed. This is what the SkyChat backend verifies at login.
   */
  async getServiceAuthToken(session: OAuthSession, aud: string): Promise<string> {
    const agent = new Agent(session.fetchHandler.bind(session));
    const { data } = await agent.com.atproto.server.getServiceAuth({ aud, lxm: SERVICE_AUTH_LXM });
    return data.token;
  }

  get session(): OAuthSession | null {
    return this._session;
  }

  clearSession(): void {
    this._session = null;
  }

  /**
   * Revokes the persisted AT Protocol OAuth session (the client library's own
   * IndexedDB-backed storage), not just the in-memory reference. Without this,
   * logout only clears the app's own JWTs — the OAuth session survives and
   * gets silently restored by tryHandleInit()/tryRestore() on next app load.
   */
  async logout(sub: string): Promise<void> {
    const client = await this.getClient();
    await client.revoke(sub);
    this._session = null;
  }

  private async signInNative(client: BrowserOAuthClient, handle: string): Promise<void> {
    // authorize() returns the URL and stores PKCE/state/redirect_uri in session storage.
    const authUrl = await client.authorize(handle, { scope: OAUTH_SCOPE });

    await Browser.open({ url: authUrl.toString(), presentationStyle: 'popover' });

    // Android App Links intercept https://bluvy.app/oauth/callback and fire appUrlOpen.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('OAuth timeout — aucun callback reçu.')),
        5 * 60 * 1000,
      );

      void App.addListener('appUrlOpen', async ({ url }) => {
        clearTimeout(timer);
        try {
          const parsedUrl = new URL(url);
          let params = parsedUrl.searchParams;
          if (!params.has('state') && parsedUrl.hash) {
            params = new URLSearchParams(parsedUrl.hash.slice(1));
          }
          await this.handleCallback(params);
          await Browser.close();
          resolve();
        } catch (err) {
          console.error('[AppUrlOpen Error]', err);
          await Browser.close().catch(() => {});
          reject(err);
        }
      });
    });
  }
}
