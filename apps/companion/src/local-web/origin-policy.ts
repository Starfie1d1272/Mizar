import { isIP } from 'node:net';

const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface LocalWebOriginPolicyOptions {
  readonly host?: string;
  readonly lanMode?: boolean;
  readonly allowedOrigins?: readonly string[];
}

export interface LocalWebOriginPolicy {
  readonly mode: 'loopback' | 'lan';
  readonly bindHost: string;
  readonly allowedOrigins: readonly string[];
}

export type OriginCheckResult =
  | { readonly allowed: true; readonly normalizedOrigin: string }
  | {
      readonly allowed: false;
      readonly reason: 'missing' | 'invalid' | 'not-allowed';
      readonly normalizedOrigin?: string;
    };

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === 'localhost' || normalized === '::1') return true;
  return isIP(normalized) === 4 && normalized === '127.0.0.1';
}

/** Check the HTTP authority itself, independent of Origin and forwarded headers. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  return host !== undefined && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host);
}

function normalizeAllowedOrigin(origin: string): string {
  const parsed = new URL(origin.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`LOCAL_WEB_ALLOWED_ORIGINS 只允许 HTTP(S) Origin（来源）：${origin}`);
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `LOCAL_WEB_ALLOWED_ORIGINS 必须是完整 Origin（来源），不能包含路径、查询参数或片段：${origin}`,
    );
  }
  return parsed.origin;
}

export function createLocalWebOriginPolicy(
  options: LocalWebOriginPolicyOptions = {},
): LocalWebOriginPolicy {
  const bindHost = options.host?.trim() || '127.0.0.1';
  const lanMode = options.lanMode ?? false;
  const allowedOrigins = (options.allowedOrigins ?? []).map(normalizeAllowedOrigin);
  const loopback = isLoopbackBindHost(bindHost);

  if (!loopback && !lanMode) {
    throw new Error(
      `HOST=${bindHost} 不是回环地址；必须显式启用 LOCAL_WEB_LAN_MODE=1 才能启动本地网页服务`,
    );
  }
  if (lanMode && allowedOrigins.length === 0) {
    throw new Error(
      'LOCAL_WEB_LAN_MODE=1 时必须通过 LOCAL_WEB_ALLOWED_ORIGINS 提供至少一个允许的 Origin（来源）',
    );
  }

  return {
    mode: lanMode ? 'lan' : 'loopback',
    bindHost,
    allowedOrigins: [...new Set(allowedOrigins)],
  };
}

function normalizedHttpOrigin(origin: string): URL | undefined {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/') {
      return undefined;
    }
    if (parsed.search !== '' || parsed.hash !== '') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function checkLocalWebOrigin(
  policy: LocalWebOriginPolicy,
  origin: string | undefined,
): OriginCheckResult {
  if (origin === undefined || origin.trim().length === 0) {
    return { allowed: false, reason: 'missing' };
  }
  const parsed = normalizedHttpOrigin(origin);
  if (parsed === undefined || parsed.origin === 'null') {
    return { allowed: false, reason: 'invalid' };
  }

  const normalizedOrigin = parsed.origin;
  if (policy.mode === 'lan') {
    return policy.allowedOrigins.includes(normalizedOrigin)
      ? { allowed: true, normalizedOrigin }
      : { allowed: false, reason: 'not-allowed', normalizedOrigin };
  }

  const hostname = normalizeHost(parsed.hostname);
  return LOOPBACK_ORIGIN_HOSTS.has(hostname)
    ? { allowed: true, normalizedOrigin }
    : { allowed: false, reason: 'not-allowed', normalizedOrigin };
}

export function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
