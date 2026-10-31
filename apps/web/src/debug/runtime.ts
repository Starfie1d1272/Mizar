export type DebugFreshness = 'awaiting' | 'fresh' | 'stale';

export interface DebugRuntimeResponse {
  readonly producerInstanceId: string | null;
  readonly sourceGeneration: number | null;
  readonly freshness: DebugFreshness;
  readonly raw: { readonly current: unknown };
  readonly normalized: { readonly current: unknown };
  readonly runtime: {
    readonly current: unknown;
    readonly lastDisposition: unknown;
  };
  readonly recentTransitions: readonly unknown[];
  readonly latestGsiDiagnostics: unknown;
  readonly recentRuntimeDiagnostics: readonly { readonly code: string }[];
  readonly recorderHealth: Record<string, unknown>;
  readonly deliveryHealth: readonly Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function parseRuntimeDiagnostics(value: unknown): readonly { readonly code: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics: Array<{ readonly code: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.code !== 'string') return undefined;
    diagnostics.push({ code: item.code });
  }
  return diagnostics;
}

function parseHealthList(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(isRecord) ? value : undefined;
}

export function parseDebugRuntimeResponse(value: unknown): DebugRuntimeResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (!nullableString(value.producerInstanceId)) return undefined;
  if (!nullableInteger(value.sourceGeneration)) return undefined;
  if (
    value.freshness !== 'awaiting' &&
    value.freshness !== 'fresh' &&
    value.freshness !== 'stale'
  ) {
    return undefined;
  }
  if (!isRecord(value.raw) || !hasOwn(value.raw, 'current')) return undefined;
  if (!isRecord(value.normalized) || !hasOwn(value.normalized, 'current')) return undefined;
  if (!isRecord(value.runtime)) return undefined;
  if (!hasOwn(value.runtime, 'current') || !hasOwn(value.runtime, 'lastDisposition')) {
    return undefined;
  }
  if (!Array.isArray(value.recentTransitions)) return undefined;
  if (!hasOwn(value, 'latestGsiDiagnostics')) return undefined;

  const recentRuntimeDiagnostics = parseRuntimeDiagnostics(value.recentRuntimeDiagnostics);
  if (recentRuntimeDiagnostics === undefined) return undefined;
  if (!isRecord(value.recorderHealth)) return undefined;
  const deliveryHealth = parseHealthList(value.deliveryHealth);
  if (deliveryHealth === undefined) return undefined;

  return {
    producerInstanceId: value.producerInstanceId,
    sourceGeneration: value.sourceGeneration,
    freshness: value.freshness,
    raw: { current: value.raw.current },
    normalized: { current: value.normalized.current },
    runtime: {
      current: value.runtime.current,
      lastDisposition: value.runtime.lastDisposition,
    },
    recentTransitions: value.recentTransitions,
    latestGsiDiagnostics: value.latestGsiDiagnostics,
    recentRuntimeDiagnostics,
    recorderHealth: value.recorderHealth,
    deliveryHealth,
  };
}

export function formatDebugJson(value: unknown): string {
  if (value === null || value === undefined) return '暂无证据';
  try {
    return JSON.stringify(value, null, 2) ?? '暂无证据';
  } catch {
    return '证据无法显示';
  }
}

export function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function numberValue(value: unknown, key: string): number | undefined {
  const candidate = recordValue(value, key);
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

export function stringValue(value: unknown, key: string): string | undefined {
  const candidate = recordValue(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}

export function explainRuntimeDiagnostic(code: string): string | undefined {
  if (code === 'output-outbox_boundary_overflow')
    return '发送队列的连续性记录已满，本次运行的相关同步已暂停；请保留诊断并核对接收端。';
  if (code === 'output-outbox_boundary_capture_failed')
    return '连续性边界未能持久保存，本次运行的同步已暂停；请检查磁盘并保留诊断。';
  if (code === 'output-outbox_recovered')
    return '发送队列读取异常，已核对同一提交并恢复完整副本，原文件已保留。发送仍受身份与时效检查保护；请核对接收端结果，可导出诊断包反馈。';
  if (code === 'output-outbox_preserved_without_records')
    return '发送队列损坏，原文件与恢复副本已隔离，无法确认完整提交与回执，旧事件暂停发送。Mizar 可继续使用，旧事件未确认送达；请核对接收端结果，并导出诊断包反馈。';
  return undefined;
}
