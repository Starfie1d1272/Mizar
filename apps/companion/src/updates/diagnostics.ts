export { errorEvidence } from '../support/diagnostic-value.js';

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
