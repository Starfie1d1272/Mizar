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

/** Keep cause structure while bounding encoded size, including escaped/multibyte text. */
export function boundDiagnostic(value: unknown, maxBytes: number): unknown {
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) <= maxBytes) return value;
  const clip = (entry: unknown, characters: number): unknown => {
    if (typeof entry === 'string')
      return entry.length > characters ? entry.slice(0, characters) + ' [truncated]' : entry;
    if (Array.isArray(entry)) return entry.slice(0, 4).map((part) => clip(part, characters));
    if (typeof entry === 'object' && entry !== null)
      return Object.fromEntries([
        ...Object.entries(entry).map(([key, field]) => [key, clip(field, characters)]),
        ['truncated', true],
      ]);
    return entry;
  };
  for (const characters of [512, 256, 128, 64]) {
    const bounded = clip(value, characters);
    if (Buffer.byteLength(JSON.stringify(bounded, null, 2)) <= maxBytes) return bounded;
  }
  return { truncated: true, message: 'Diagnostic exceeded the bounded export budget' };
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
      statusCode?: unknown;
      source?: unknown;
      errors?: unknown[];
      rateLimited?: boolean;
      stack?: unknown;
      issues?: unknown[];
    };
    const schemaError = original.name === 'ZodError' && Array.isArray(fields.issues);
    // Zod message/stack headers can embed arbitrary rejected values, including fake callsites.
    // Keep the wrapper's stack and safe issue metadata instead of copying this header.
    const stack = !schemaError && typeof fields.stack === 'string' ? fields.stack : undefined;
    return {
      name: redactDiagnosticText(typeof original.name === 'string' ? original.name : 'Error'),
      message: redactDiagnosticText(
        schemaError
          ? 'Schema validation failed; see issue codes and paths'
          : typeof original.message === 'string'
            ? original.message
            : serializedError(value),
      ),
      ...(stack === undefined ? {} : { stack: redactDiagnosticText(stack) }),
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
      ...(typeof fields.code === 'string'
        ? { code: redactDiagnosticText(fields.code) }
        : typeof fields.code === 'number' && Number.isFinite(fields.code)
          ? { code: fields.code }
          : {}),
      ...(typeof (fields.status ?? fields.statusCode) === 'number'
        ? { status: fields.status ?? fields.statusCode }
        : {}),
      ...(fields.rateLimited ? { rateLimited: true } : {}),
      ...(typeof fields.source === 'string' ? { source: redactDiagnosticText(fields.source) } : {}),
      ...(original.cause === undefined ? {} : { cause: visit(original.cause, depth + 1) }),
      ...(Array.isArray(fields.errors)
        ? { errors: fields.errors.slice(0, 4).map((e) => visit(e, depth + 1)) }
        : {}),
    };
  };
  return boundDiagnostic(visit(error, 0), 32 * 1024);
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
