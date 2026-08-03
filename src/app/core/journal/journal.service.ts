import { Injectable } from '@angular/core';

export type LogLevel = 'log' | 'warn' | 'error';

export interface JournalEntry {
  id:        string;
  timestamp: number;
  level:     LogLevel;
  tag:       string;
  message:   string;
  detail:    string | null;
}

// Sensitive patterns to scrub before storing
const SENSITIVE_PATTERNS: RegExp[] = [
  /accessToken\s*[=:]\s*\S+/gi,
  /refreshToken\s*[=:]\s*\S+/gi,
  /password\s*[=:]\s*\S+/gi,
  /private[_\s]?key\s*[=:]\s*\S+/gi,
  /secret\s*[=:]\s*\S+/gi,
  /mbk\s*[=:]\s*\S+/gi,
  // Base58 recovery keys (51+ char alphanumeric strings)
  /\b[1-9A-HJ-NP-Za-km-z]{51,}\b/g,
  // Base64 private key blobs
  /(?:[A-Za-z0-9+/]{40,}={0,2})/g,
];

const RETENTION_MS  = 48 * 60 * 60 * 1000; // 48h stored
const MAX_ENTRIES   = 1000;
const DB_NAME       = 'bluvy-journal';
const DB_VERSION    = 1;
const STORE_NAME    = 'entries';

function scrub(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function parseTag(args: unknown[]): { tag: string; rest: unknown[] } {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith('[')) {
    const match = first.match(/^(\[[^\]]+\])/);
    if (match) {
      const tag = match[1];
      const remainder = first.slice(tag.length).trim();
      return { tag, rest: remainder ? [remainder, ...args.slice(1)] : args.slice(1) };
    }
  }
  return { tag: '[app]', rest: args };
}

function serialize(args: unknown[]): { message: string; detail: string | null } {
  const parts: string[] = [];
  const details: unknown[] = [];
  for (const a of args) {
    if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
      parts.push(String(a));
    } else {
      details.push(a);
    }
  }
  return {
    message: scrub(parts.join(' ')),
    detail: details.length > 0 ? scrub(JSON.stringify(details, null, 2)) : null,
  };
}

type CapturedEntry = Omit<JournalEntry, 'id'>;
type Sink = (entry: CapturedEntry) => void;

// Entries captured before a sink is attached (i.e. before JournalService's
// IndexedDB is open) are queued here instead of dropped, then flushed once
// the sink attaches — see startConsoleCapture()/JournalService.constructor.
let sink: Sink | null = null;
const buffer: CapturedEntry[] = [];
let intercepted = false;

// Patches console.log/warn/error to capture entries. Deliberately a plain
// module-level function, not something wired up inside JournalService's
// constructor: it must run as the very first statement in main.ts, before
// Angular bootstraps (before checkAndClearCache(), APP_INITIALIZER/OAuth
// init, AppComponent construction, etc.) so boot-time logs from those paths
// aren't silently lost just because JournalService doesn't exist yet.
export function startConsoleCapture(): void {
  if (intercepted) return;
  intercepted = true;

  const original = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  const capture = (level: LogLevel) => (...args: unknown[]) => {
    original[level](...args);
    const { tag, rest } = parseTag(args);
    const { message, detail } = serialize(rest);
    if (!message) return;
    const entry: CapturedEntry = { timestamp: Date.now(), level, tag, message, detail };
    if (sink) sink(entry);
    else buffer.push(entry);
  };

  console.log   = capture('log');
  console.warn  = capture('warn');
  console.error = capture('error');
}

@Injectable({ providedIn: 'root' })
export class JournalService {
  private db: IDBDatabase | null = null;
  private ready = false;

  constructor() {
    this.open().then(() => {
      this.purge();
      // Attach as the persistence sink, then flush anything captured while
      // the DB was still opening (including everything logged before this
      // service was even constructed) -- each entry keeps its original
      // capture timestamp, not the flush time.
      sink = (entry) => this.write(entry);
      const queued = buffer.splice(0, buffer.length);
      for (const entry of queued) this.write(entry);
    });
  }

  // ── IndexedDB ─────────────────────────────────────────────────────────────

  private open(): Promise<void> {
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp');
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        this.ready = true;
        resolve();
      };
      req.onerror = () => resolve(); // fail-safe: no crash
    });
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  private write(entry: CapturedEntry): void {
    if (!this.ready || !this.db) return;
    const full: JournalEntry = {
      id: crypto.randomUUID(),
      ...entry,
    };
    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add(full);
    } catch { /* fail-safe */ }
  }

  // ── Purge (TTL + max) ─────────────────────────────────────────────────────

  purge(): void {
    if (!this.ready || !this.db) return;
    const cutoff = Date.now() - RETENTION_MS;
    try {
      const tx    = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const idx   = store.index('timestamp');
      const range = IDBKeyRange.upperBound(cutoff);
      idx.openCursor(range).onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    } catch { /* fail-safe */ }
  }

  // ── Read (display window = 2h) ────────────────────────────────────────────

  getEntries(windowMs = 2 * 60 * 60 * 1000): Promise<JournalEntry[]> {
    return new Promise((resolve) => {
      if (!this.ready || !this.db) return resolve([]);
      const since = Date.now() - windowMs;
      try {
        const tx    = this.db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const idx   = store.index('timestamp');
        const range = IDBKeyRange.lowerBound(since);
        const all: JournalEntry[] = [];
        idx.openCursor(range, 'prev').onsuccess = (e) => {
          const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
          if (cursor) {
            if (all.length < MAX_ENTRIES) all.push(cursor.value as JournalEntry);
            cursor.continue();
          } else {
            resolve(all);
          }
        };
      } catch { resolve([]); }
    });
  }

  clearAll(): void {
    if (!this.ready || !this.db) return;
    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch { /* fail-safe */ }
  }
}
