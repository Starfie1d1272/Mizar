import { redactDiagnosticText, diagnosticNetworkCode } from '../updates/diagnostics.js';

export type LiveErrorEvidence = { name: string; code?: string | number; cause?: LiveErrorEvidence };

function liveErrorIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
  )
    return undefined;
  return redactDiagnosticText(value) === value ? value : undefined;
}

// Do not retain messages/stacks: fetch and JSON errors can contain URLs, tokens or response bytes.
export function liveErrorEvidence(error: unknown, depth = 0): LiveErrorEvidence {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const name = liveErrorIdentifier(error.name) ?? 'UnknownError';
  const rawCode = 'code' in error ? error.code : undefined;
  const code =
    typeof rawCode === 'number' && Number.isSafeInteger(rawCode) && Math.abs(rawCode) <= 2147483647
      ? rawCode
      : liveErrorIdentifier(rawCode);
  return {
    name,
    ...(code === undefined ? {} : { code }),
    ...(depth < 2 && error.cause !== undefined
      ? { cause: liveErrorEvidence(error.cause, depth + 1) }
      : {}),
  };
}
export function liveTimeout(error: LiveErrorEvidence): boolean {
  return (
    error.name === 'TimeoutError' ||
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(String(error.code ?? '')) ||
    (error.cause !== undefined && liveTimeout(error.cause))
  );
}

export function requestFailureReason(error: unknown): string {
  if (error instanceof RivalHubResponseError)
    return error.code === 'RIVALHUB_INVALID_JSON' ? 'invalid_response' : 'response_read_failed';
  if (error instanceof Error && 'code' in error && error.code === 'RIVALHUB_TIMEOUT')
    return 'timeout';
  if (error instanceof Error && 'code' in error && error.code === 'RIVALHUB_NETWORK_FAILED')
    return 'network_failed';
  const evidence = liveErrorEvidence(error);
  if (liveTimeout(evidence)) return 'timeout';
  if (evidence.name === 'SyntaxError') return 'invalid_response';
  const network = (e: LiveErrorEvidence): boolean =>
    e.name === 'TypeError' || (e.cause !== undefined && network(e.cause));
  return network(evidence) ? 'network_failed' : 'unknown';
}
export function rootNetworkCode(evidence: LiveErrorEvidence): string | undefined {
  return (
    (evidence.cause ? rootNetworkCode(evidence.cause) : undefined) ??
    diagnosticNetworkCode(evidence.code)
  );
}

export function requestFailureCode(error: unknown): string | undefined {
  if (error instanceof Error && 'rootCauseCode' in error) {
    const code = diagnosticNetworkCode(error.rootCauseCode);
    if (code) return code;
  }
  return rootNetworkCode(liveErrorEvidence(error));
}

export class RivalHubResponseError extends Error {
  readonly code: 'RIVALHUB_INVALID_JSON' | 'RIVALHUB_RESPONSE_READ_FAILED';
  constructor(kind: 'parse' | 'read') {
    super(
      kind === 'parse'
        ? 'RivalHub 返回的数据无法解析，请稍后重试。'
        : 'RivalHub 响应读取失败，请稍后重试。',
    );
    this.name = 'RivalHubResponseError';
    this.code = kind === 'parse' ? 'RIVALHUB_INVALID_JSON' : 'RIVALHUB_RESPONSE_READ_FAILED';
  }
}
export function networkError(error: unknown): Error {
  if (error instanceof RivalHubResponseError) return error;
  const project = (raw: LiveErrorEvidence): LiveErrorEvidence => {
    const code = diagnosticNetworkCode(raw.code);
    return {
      name: ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'SyntaxError'].includes(raw.name)
        ? raw.name
        : 'UnknownError',
      ...(code ? { code } : {}),
      ...(raw.cause ? { cause: project(raw.cause) } : {}),
    };
  };
  const evidence = project(liveErrorEvidence(error));
  const rootCauseCode = requestFailureCode(error);
  const timeout =
    liveTimeout(evidence) ||
    (rootCauseCode !== undefined && liveTimeout({ name: 'UnknownError', code: rootCauseCode }));
  const network = evidence.name === 'TypeError' || rootCauseCode !== undefined;
  return Object.assign(
    new Error(
      timeout
        ? '连接 RivalHub 超时，请检查网络后重试。'
        : network
          ? '连接 RivalHub 失败，请检查网络后重试。'
          : 'RivalHub 请求未完成，请稍后重试。',
      { cause: evidence },
    ),
    {
      name: 'RivalHubRequestError',
      ...(rootCauseCode ? { rootCauseCode } : {}),
      code: timeout
        ? 'RIVALHUB_TIMEOUT'
        : network
          ? 'RIVALHUB_NETWORK_FAILED'
          : 'RIVALHUB_REQUEST_FAILED',
    },
  );
}
