import { createHash } from 'node:crypto';
import { BOX_READ_TOKEN } from '../updates/contract.js';

const credential =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:password|passwd|token|secret|credential)|api[_-]?key|stream[_-]?key|device[_-]?code|user[_-]?code|pairing[_-]?code|ticket)$/i;
const chatIdentity = new Set([
  'schema',
  'eventId',
  'producerKind',
  'producerRunId',
  'sequence',
  'kind',
  'stage',
  'phase',
  'outcome',
  'time',
  'observedAt',
  'recordedAt',
  'startupSessionId',
  'taskId',
  'operationId',
  'parentOperationId',
  'attemptId',
  'sourceInterval',
]);

const POTENTIAL_SENSITIVE_RAW =
  /password|passwd|token|secret|credential|ticket|authorization|cookie|bearer|basic|rh_mizar_|data:|"key"|_key|-key|:\/\/|program_all_chat|\\u|"\s*[{[]/i;

/** Fast pre-check: when false, `diagnosticEvidence(JSON.parse(raw))` is a no-op clone. */
export function needsEvidenceSanitize(rawJson: string): boolean {
  return rawJson.includes(BOX_READ_TOKEN) || POTENTIAL_SENSITIVE_RAW.test(rawJson);
}

export function diagnosticEvidence(value: unknown): unknown {
  return sanitize(value, '', new Set(), [], true);
}

/** Preserve technical context; replace credential values, never whole events. */
export function diagnosticValue(
  value: unknown,
  key = '',
  seen = new Set<object>(),
  secrets: readonly string[] = [],
): unknown {
  return sanitize(value, key, seen, secrets, false);
}

function sanitize(
  value: unknown,
  key: string,
  seen: Set<object>,
  secrets: readonly string[],
  excludeChat: boolean,
): unknown {
  if (
    key === 'ticket' &&
    typeof value === 'string' &&
    /^\[redacted-ticket:[a-f0-9]{64}\]$/.test(value)
  )
    return value;
  // A Host exit ticket is a capability, not a business identifier. Its random UUID may be linked by digest only.
  if (
    key === 'ticket' &&
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    return `[redacted-ticket:${createHash('sha256').update(value).digest('hex')}]`;
  if (credential.test(key)) return '[redacted]';
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular error]';
    seen.add(value);
    const fields = Object.fromEntries(
      Object.getOwnPropertyNames(value).map((name) => [
        name,
        (value as unknown as Record<string, unknown>)[name],
      ]),
    );
    const result = sanitize(
      { ...fields, name: value.name, message: value.message, stack: value.stack },
      key,
      seen,
      secrets,
      excludeChat,
    );
    seen.delete(value);
    return result;
  }
  if (Buffer.isBuffer(value))
    return {
      bytes: value.length,
      sha256: createHash('sha256').update(value).digest('hex'),
      content: 'binary-not-collected',
    };
  if (typeof value === 'string' && /^data:[^,]+;base64,/.test(value))
    return {
      content: 'media-not-collected',
      bytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    };
  if (typeof value === 'string') {
    let cleanText = value.replaceAll(BOX_READ_TOKEN, '[redacted]');
    for (const secret of secrets)
      if (secret) cleanText = cleanText.replaceAll(secret, '[redacted]');
    if (/^\s*[{[]/.test(cleanText)) {
      try {
        return JSON.stringify(sanitize(JSON.parse(cleanText), key, seen, secrets, excludeChat));
      } catch {
        /* A plain error or partial record remains text. */
      }
    }
    return cleanText
      .replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi, (text) => {
        try {
          const url = new URL(text);
          if (url.username || url.password) {
            url.username = '[redacted]';
            url.password = '';
          }
          for (const name of [...url.searchParams.keys()])
            if (credential.test(name) || /^(?:code|auth|key)$/i.test(name))
              url.searchParams.set(name, '[redacted]');
          if (/^rtmps?:$/.test(url.protocol)) {
            const parts = url.pathname.split('/');
            if (parts.length > 2) {
              parts[parts.length - 1] = '[redacted]';
              url.pathname = parts.join('/');
            }
          }
          return url.toString();
        } catch {
          return text;
        }
      })
      .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [redacted]')
      .replace(/rh_mizar_[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(
        /((?:password|passwd|access[_-]?token|refresh[_-]?token|token|secret|credential|api[_-]?key|stream[_-]?key|ticket)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&?#]+)/gi,
        '$1[redacted]',
      );
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitize(item, '', seen, secrets, excludeChat));
  } else {
    const record = value as Record<string, unknown>;
    const kind = excludeChat ? String(record.kind ?? record.stage) : '';
    const chat = kind === 'program_all_chat' || kind === 'program_all_chat_reset';
    const entries = chat
      ? Object.entries(record).filter(([name]) => chatIdentity.has(name))
      : Object.entries(record);
    for (const entry of entries) {
      const [name, item] = entry;
      const field = name === 'key' && /stream/i.test(key) ? 'streamKey' : name;
      entry[1] = sanitize(item, field, seen, secrets, excludeChat);
    }
    if (chat) {
      entries.push(
        ['evidence', { excluded: 'raw-chat-body', scope: 'identity and source interval only' }],
        ['coverage', { excluded: ['raw-chat-body'], unknown: [] }],
      );
    }
    result = Object.fromEntries(entries);
  }
  seen.delete(value);
  return result;
}
