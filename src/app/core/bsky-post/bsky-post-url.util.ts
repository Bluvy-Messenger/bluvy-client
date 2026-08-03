// Path-shape detection for Bluesky post links -- deliberately host-agnostic
// (no allow-list) since multiple independent AT-Proto web clients (bsky.app,
// mu.social, ...) share the same /profile/<handle-or-did>/post/<rkey> routing
// convention. We never navigate to or embed content from this host, we only
// read the path, so there is no reason to restrict which hosts are matched.

export interface BskyPostUrlMatch {
  handleOrDid: string;
  rkey: string;
}

// Mirrors @atproto/syntax's own DID/record-key regexes (did.js, recordkey.js)
// without adding it as an undeclared direct dependency.
const DID_REGEX = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const HANDLE_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const RECORD_KEY_REGEX = /^[a-zA-Z0-9_~.:-]{1,512}$/;
const RECORD_KEY_INVALID_VALUES = new Set(['.', '..']);

function isValidHandleOrDid(value: string): boolean {
  return DID_REGEX.test(value) || HANDLE_REGEX.test(value);
}

function isValidRecordKey(value: string): boolean {
  return RECORD_KEY_REGEX.test(value) && !RECORD_KEY_INVALID_VALUES.has(value);
}

/** Real path-segment parsing against AT-Proto's own DID/handle/rkey syntax -- never substring matching. */
export function parseBskyPostUrl(rawUrl: string): BskyPostUrlMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  if (segments.length !== 4 || segments[0] !== 'profile' || segments[2] !== 'post') return null;

  const [, handleOrDid, , rkey] = segments;
  if (!isValidHandleOrDid(handleOrDid) || !isValidRecordKey(rkey)) return null;

  return { handleOrDid, rkey };
}
