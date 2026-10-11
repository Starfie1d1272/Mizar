export type SourceFailureCode =
  | 'network'
  | 'timeout'
  | 'authorization'
  | 'not_found'
  | 'unavailable'
  | 'invalid_response'
  | 'invalid_manifest'
  | 'match_mismatch';

/**
 * Expected source-side failure from a MatchContext or ScheduleWindow loader.
 *
 * Loaders must wrap network, availability, file, and source-format failures
 * in this error. Other exceptions are treated as programmer/invariant errors
 * and are deliberately allowed to cross the acquisition boundary.
 */
export class SourceLoadError extends Error {
  readonly cause: unknown;
  readonly code: SourceFailureCode;

  constructor(
    message: string,
    cause?: unknown,
    code: SourceFailureCode = 'unavailable',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SourceLoadError';
    this.cause = cause;
    this.code = code;
  }
}

/** Retain machine evidence, never fetch messages, stacks, URLs or response bytes. */
export function sourceErrorEvidence(
  error: unknown,
  depth = 0,
): {
  name: string;
  code?: string | number;
  status?: number;
  cause?: ReturnType<typeof sourceErrorEvidence>;
} {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const identifier = (value: unknown) =>
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value) &&
    !/token|secret|credential|password|rh_mizar_/i.test(value)
      ? value
      : undefined;
  const rawCode = 'code' in error ? error.code : undefined;
  const code =
    typeof rawCode === 'number' && Number.isSafeInteger(rawCode) && Math.abs(rawCode) <= 2147483647
      ? rawCode
      : identifier(rawCode);
  return {
    name: identifier(error.name) ?? 'UnknownError',
    ...(code === undefined ? {} : { code }),
    ...(error instanceof SourceLoadError && error.status !== undefined
      ? { status: error.status }
      : {}),
    ...(depth < 2 && error.cause !== undefined
      ? { cause: sourceErrorEvidence(error.cause, depth + 1) }
      : {}),
  };
}
