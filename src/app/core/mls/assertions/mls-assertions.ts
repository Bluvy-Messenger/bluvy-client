import { environment } from '../../../../environments/environment';

export class MlsAssertionError extends Error {
  override readonly name = 'MlsAssertionError';

  constructor(
    assertion: string,
    public readonly actual: unknown,
    public readonly expected: unknown,
  ) {
    super(
      `MLS assertion failed: ${assertion}. Expected ${String(expected)}, got ${String(actual)}.`,
    );
  }
}

// Verifies a precondition on an MLS coordinator public API.
// In development: throws MlsAssertionError immediately.
// In production: logs a critical error and continues (fail-safe).
export function assertMls(
  condition: boolean,
  message:   string,
  context:   Record<string, unknown> = {},
): void {
  if (!condition) {
    if (!environment.production) {
      console.error('[MLS:assertion] FAILED:', message, context);
      throw new MlsAssertionError(message, context, true);
    }
  }
}
