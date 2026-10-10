import { BOX_READ_TOKEN } from './contract.js';

/** Only bounded, redacted error evidence enters local logs; never response bodies. */
export function errorEvidence(error: unknown): unknown {
  const seen = new Set<unknown>();
  let remaining = 12;
  const clean = (value: string) =>
    value
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
        /authorization|bearer|token|password|secret|api[_-]?key/i.test(line)
          ? '[credential-bearing line redacted]'
          : line,
      )
      .join('\n')
      .slice(0, 512);
  const visit = (value: unknown, depth: number): unknown => {
    if (remaining-- <= 0 || depth >= 6 || seen.has(value)) return { truncated: true };
    if (!(value instanceof Error))
      return { name: 'NonError', message: '[unstructured error omitted]' };
    seen.add(value);
    const fields = value as Error & {
      code?: unknown;
      status?: unknown;
      source?: unknown;
      errors?: unknown[];
    };
    return {
      name: clean(value.name),
      // Zod messages can embed rejected private data; retain type, not input.
      message: value.name === 'ZodError' ? '[schema validation failed]' : clean(value.message),
      ...(typeof fields.code === 'string' ? { code: clean(fields.code) } : {}),
      ...(typeof fields.status === 'number' ? { status: fields.status } : {}),
      ...(typeof fields.source === 'string' ? { source: clean(fields.source) } : {}),
      ...(value.cause === undefined ? {} : { cause: visit(value.cause, depth + 1) }),
      ...(Array.isArray(fields.errors)
        ? { errors: fields.errors.slice(0, 4).map((e) => visit(e, depth + 1)) }
        : {}),
    };
  };
  return visit(error, 0);
}

export class UpdateRequestError extends Error {
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
