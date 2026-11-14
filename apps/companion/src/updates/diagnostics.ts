import { BOX_READ_TOKEN } from './contract.js';
import { diagnosticValue } from '../support/diagnostic-value.js';

/** Fixed transport codes only; never treat arbitrary exception fields as diagnostics. */
export function diagnosticNetworkCode(value: unknown): string | undefined {
  return typeof value === 'string' &&
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(value)
    ? value
    : undefined;
}

export function redactDiagnosticText(value: string): string {
  const clean = value
    .replaceAll(BOX_READ_TOKEN, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        return new URL(url).origin + '/[redacted-url]';
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/([a-z]:[\\/]+Users[\\/]+)[^\\/\s]+/gi, '$1[user]')
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1[user]')
    .split('\n')
    .map((line) =>
      /(?:authorization|token|password|credential|secret|api[_-]?key)["']?\s*[:=]|bearer\s+\S+|rh_mizar_[a-z0-9_-]+/i.test(
        line,
      )
        ? '[credential-bearing line redacted]'
        : line,
    )
    .join('\n');
  return clean.length > 4096 ? clean.slice(0, 4096) + ' [truncated at 4096 characters]' : clean;
}

/** Local evidence keeps the complete error chain; display summaries have a separate policy. */
export function errorEvidence(error: unknown): unknown {
  const seen = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (!(value instanceof Error)) return diagnosticValue(value);
    if (seen.has(value)) return '[circular error]';
    seen.add(value);
    const evidence = diagnosticValue(value) as Record<string, unknown>;
    const fields = value as Error & { issues?: unknown[]; errors?: unknown[] };
    if (value.name === 'ZodError' && Array.isArray(fields.issues)) {
      // Rejected values can embed credentials, including fake stack frames.
      // Preserve every issue's locator without copying that untrusted header.
      evidence.message = 'Schema validation failed; see issue codes and paths';
      delete evidence.stack;
      evidence.issues = fields.issues.map((issue) => {
        const { code, path, expected } = issue as Record<string, unknown>;
        return diagnosticValue({ code, path, expected });
      });
      evidence.coverage = { excluded: ['schema-rejected-values-and-stack-header'] };
    }
    if (value.cause !== undefined) evidence.cause = visit(value.cause);
    if (Array.isArray(fields.errors)) evidence.errors = fields.errors.map(visit);
    seen.delete(value);
    return evidence;
  };
  return visit(error);
}

export class UpdateRequestError extends Error {
  rateLimited = false;
  constructor(
    message: string,
    readonly source: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'UpdateRequestError';
  }
}
