import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Fetch-compatible adapter passed to BrowserOAuthClient.load({ fetch }).
 *
 * @atproto/oauth-client-browser defaults every network call (client-metadata.json,
 * .well-known/oauth-* discovery, PAR, token exchange, DPoP-nonce retries) to
 * globalThis.fetch unless a `fetch` override is supplied. On Android that's the
 * WebView's real fetch, which enforces CORS against the WebView's own origin —
 * unlike CapacitorHttp, which performs the request natively and is CORS-exempt.
 *
 * This mirrors ApiClientService.sendNative()'s Capacitor.isNativePlatform() ->
 * CapacitorHttp.request() pattern, but as a raw fetch-signature adapter (no JSON
 * envelope, no auth headers, no 401 retry) since that's the shape the OAuth
 * library's extension point requires.
 */
export async function capacitorOAuthFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!Capacitor.isNativePlatform()) {
    return globalThis.fetch(input, init);
  }

  const request = input instanceof Request && init === undefined
    ? input
    : new Request(input, init);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const bodyText = hasBody ? await request.text() : undefined;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });

  // redirect:'error' has no exact CapacitorHttp equivalent; disableRedirects
  // returns the raw 3xx instead of throwing at the network layer, but all
  // callers already reject non-200 responses regardless of cause.
  const disableRedirects = request.redirect === 'manual' || request.redirect === 'error';

  const response = await CapacitorHttp.request({
    method: request.method,
    url: request.url,
    data: bodyText,
    headers,
    disableRedirects,
    connectTimeout: 15_000,
    readTimeout: 15_000,
  });

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    responseHeaders.set(key, value);
  }

  // Capacitor auto-parses JSON-content-typed bodies into JS objects natively;
  // every response in this flow is JSON, so re-serialize before wrapping in Response.
  const responseBody =
    response.data === undefined || response.data === null ? undefined
    : typeof response.data === 'string' ? response.data
    : JSON.stringify(response.data);

  return new Response(responseBody, { status: response.status, headers: responseHeaders });
}
