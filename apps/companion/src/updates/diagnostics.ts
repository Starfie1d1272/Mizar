import { BOX_READ_TOKEN } from './contract.js';

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

function serializedError(value: object): string {
  try {
    return JSON.stringify(value, (key, field: unknown) =>
      /token|password|authorization|secret|allplayers|matchdocument|steam64/i.test(key)
        ? '[redacted]'
        : field,
    );
  } catch {
    return '[unserializable exception; cause retained separately]';
  }
}

/** Only bounded, redacted error evidence enters local logs; never response bodies. */
export function errorEvidence(error: unknown): unknown {
  const seen = new Set<unknown>();
  let remaining = 12;
  const visit = (value: unknown, depth: number): unknown => {
    if (remaining-- <= 0 || depth >= 6 || seen.has(value)) return { truncated: true };
    if (typeof value !== 'object' || value === null)
      return { name: 'NonError', message: redactDiagnosticText(String(value)) };
    const original = value as { name?: unknown; message?: unknown; cause?: unknown };
    seen.add(value);
    const fields = value as Error & {
      code?: unknown;
      status?: unknown;
      source?: unknown;
      errors?: unknown[];
      rateLimited?: boolean;
      stack?: unknown;
      issues?: unknown[];
    };
    return {
      name: redactDiagnosticText(typeof original.name === 'string' ? original.name : 'Error'),
      message: redactDiagnosticText(
        typeof original.message === 'string' ? original.message : serializedError(value),
      ),
      ...(typeof fields.stack === 'string' ? { stack: redactDiagnosticText(fields.stack) } : {}),
      ...(Array.isArray(fields.issues)
        ? {
            issues: fields.issues.slice(0, 16).map((issue) => {
              const value = issue as { code?: unknown; path?: unknown[]; expected?: unknown };
              return {
                code: typeof value.code === 'string' ? redactDiagnosticText(value.code) : null,
                path: Array.isArray(value.path)
                  ? value.path
                      .slice(0, 16)
                      .map((part) =>
                        typeof part === 'string'
                          ? redactDiagnosticText(part)
                          : typeof part === 'number'
                            ? part
                            : '[unknown]',
                      )
                  : [],
                expected:
                  typeof value.expected === 'string' ? redactDiagnosticText(value.expected) : null,
              };
            }),
            ...(fields.issues.length > 16 ? { issuesTruncated: true } : {}),
          }
        : {}),
      ...(typeof fields.code === 'string' ? { code: redactDiagnosticText(fields.code) } : {}),
      ...(typeof fields.status === 'number' ? { status: fields.status } : {}),
      ...(fields.rateLimited ? { rateLimited: true } : {}),
      ...(typeof fields.source === 'string' ? { source: redactDiagnosticText(fields.source) } : {}),
      ...(original.cause === undefined ? {} : { cause: visit(original.cause, depth + 1) }),
      ...(Array.isArray(fields.errors)
        ? { errors: fields.errors.slice(0, 4).map((e) => visit(e, depth + 1)) }
        : {}),
    };
  };
  return visit(error, 0);
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
