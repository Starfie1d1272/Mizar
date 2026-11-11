import type { DocumentHandoffCoverage } from '@mizar/protocol';

let controlDeliveryFailures = 0;
let unconfirmedRecords = 0;
const httpPending = new Map<number, Promise<void>>();
let browserDocumentId: string | null = null;
let documentSequence = 0;
const hostQueue: Record<string, unknown>[] = [];
let hostSending: Promise<void> | undefined;
let hostRetry: ReturnType<typeof setTimeout> | undefined;
function handoffHost(): Promise<void> {
  if (hostSending) return hostSending;
  if (!hostQueue.length) return Promise.resolve();
  const events: Record<string, unknown>[] = [];
  let bytes = 2;
  for (const event of hostQueue.slice(0, 64)) {
    const length = JSON.stringify(event).length * 3 + 1;
    if (bytes + length > 240 * 1024) break;
    events.push(event);
    bytes += length;
  }
  hostSending = window
    .__TAURI_INTERNALS__!.invoke<{ eventIds: string[] }>('persist_diagnostic_events', { events })
    .then((receipt) => {
      const ids = new Set(receipt.eventIds);
      for (let i = hostQueue.length - 1; i >= 0; i--)
        if (ids.has(hostQueue[i]!.eventId as string)) hostQueue.splice(i, 1);
    })
    .catch(() => {
      controlDeliveryFailures++;
    })
    .finally(() => {
      hostSending = undefined;
      if (hostQueue.length && !hostRetry)
        hostRetry = setTimeout(() => {
          hostRetry = undefined;
          void handoffHost();
        }, 1000);
    });
  return hostSending;
}

export function browserErrorEvidence(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error)) return error;
  if (seen.has(error)) return { circular: true };
  seen.add(error);
  const fields = error as Error & { code?: unknown; errors?: unknown[] };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: fields.code,
    ...(error.cause === undefined ? {} : { cause: browserErrorEvidence(error.cause, seen) }),
    ...(Array.isArray(fields.errors)
      ? { errors: fields.errors.map((value) => browserErrorEvidence(value, seen)) }
      : {}),
  };
}

// Best effort local diagnostics. Failure is never allowed to change the product operation.
export function sendControlEvidence(
  operation: string,
  phase: string,
  evidence: unknown,
): Promise<void> {
  let retainedByHost = false;
  try {
    browserDocumentId ??= crypto.randomUUID();
    const context =
      evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : {};
    // ControlTask owns its terminal result inside the current task evidence envelope.
    // Native command results may be objects/booleans; keep those in evidence only.
    const taskEvidence =
      operation === 'task' &&
      (phase === 'terminal' || phase === 'step_terminal') &&
      context.evidence &&
      typeof context.evidence === 'object'
        ? (context.evidence as Record<string, unknown>)
        : null;
    const result = taskEvidence ? taskEvidence.result : context.result;
    const outcome =
      typeof result === 'string' && result.length > 0 && result.length <= 160 ? result : null;
    const sequence = ++documentSequence;
    const now = new Date().toISOString();
    const event = {
      schema: 'mizar-diagnostic-event/2',
      eventId: `${browserDocumentId}:${sequence}`,
      producerKind: 'document',
      producerRunId: browserDocumentId,
      sequence,
      kind: operation,
      phase,
      outcome,
      observedAt: now,
      recordedAt: now,
      monotonicMs: performance.now(),
      sourceInterval: null,
      taskId: context.taskId ?? null,
      operationId: context.operationId ?? null,
      parentOperationId: context.parentOperationId ?? null,
      attemptId: context.attemptId ?? null,
      scope: { page: location.pathname },
      evidence,
      coverage: {
        durability: 'pending',
        unknown: ['document-termination-before-handoff'],
        excluded: controlDeliveryFailures
          ? [`unhanded_records_or_attempt_failures:${controlDeliveryFailures}`]
          : [],
        replayCount: 0,
        occurrences: 1,
      },
    };
    if (window.__TAURI_INTERNALS__) {
      if (hostQueue.length >= 256 || JSON.stringify(event).length > 32768) {
        controlDeliveryFailures++;
        unconfirmedRecords++;
        return Promise.resolve();
      }
      hostQueue.push(event);
      retainedByHost = true;
      return handoffHost();
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [field, header] of [
      ['taskId', 'x-mizar-task-id'],
      ['attemptId', 'x-mizar-attempt-id'],
      ['operationId', 'x-mizar-operation-id'],
      ['parentOperationId', 'x-mizar-parent-operation-id'],
    ] as const) {
      const value = context[field];
      if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
        headers[header] = value;
    }
    if (context.trigger === 'user' || context.trigger === 'system')
      headers['x-mizar-trigger'] = context.trigger;
    const delivery = fetch('/debug/control-event', {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers,
      body: JSON.stringify(event),
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok) {
          controlDeliveryFailures++;
          unconfirmedRecords++;
        }
      })
      .catch(() => {
        controlDeliveryFailures++;
        unconfirmedRecords++;
      })
      .finally(() => {
        httpPending.delete(sequence);
      });
    httpPending.set(sequence, delivery);
    return delivery;
  } catch {
    controlDeliveryFailures++;
    if (!retainedByHost) unconfirmedRecords++;
    /* Diagnostics cannot change the operation. */
    return Promise.resolve();
  }
}

export function controlEvidence(operation: string, phase: string, evidence: unknown): void {
  void sendControlEvidence(operation, phase, evidence);
}

/** Observe controls inside Mizar only; never inspect arbitrary files or other applications. */
export function installControlJournal(): void {
  window.addEventListener('error', (event) => {
    // Exclude extension/foreign scripts and resource errors outside Mizar code.
    if (!(event instanceof ErrorEvent)) return;
    if (event.filename) {
      try {
        if (new URL(event.filename, location.href).origin !== location.origin) return;
      } catch {
        return;
      }
    }
    controlEvidence('browser_error', 'failure', {
      page: location.pathname,
      file: event.filename,
      line: event.lineno,
      column: event.colno,
      error: browserErrorEvidence(event.error ?? new Error(event.message)),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    controlEvidence('browser_unhandled_rejection', 'failure', {
      page: location.pathname,
      error: browserErrorEvidence(event.reason),
      scope: 'unhandled promise rejection in this Mizar document; task attribution unknown',
    });
  });
  const observe = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !document.getElementById('root')?.contains(target))
      return;
    const element = target.closest('button,input,select,textarea,a');
    if (!(element instanceof HTMLElement)) return;
    if (event.type === 'click' && !['BUTTON', 'A'].includes(element.tagName)) return;
    const input = element as HTMLInputElement;
    const label =
      element.getAttribute('aria-label') ??
      input.labels?.[0]?.textContent?.trim() ??
      (input.name || element.id);
    const sensitive =
      input.type === 'password' ||
      /password|passwd|token|secret|credential|api.?key|stream.?key|密码|令牌|密钥|授权码|验证码/i.test(
        `${label} ${element.id}`,
      );
    controlEvidence('ui_control', event.type, {
      page: location.pathname,
      tag: element.tagName,
      label: label || element.textContent?.trim(),
      type: input.type,
      value: sensitive ? '[redacted]' : input.type === 'file' ? undefined : input.value,
      checked: input.type === 'checkbox' ? input.checked : undefined,
      files:
        input.type === 'file'
          ? Array.from(input.files ?? []).map((file) => ({
              name: file.name,
              bytes: file.size,
              type: file.type,
            }))
          : undefined,
    });
  };
  document.addEventListener('click', observe, true);
  document.addEventListener('change', observe, true);
  const transport = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith('/operator/') ||
      method === 'GET'
    )
      return transport(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const suppliedId = headers.get('x-mizar-operation-id');
    const operationId =
      suppliedId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(suppliedId)
        ? suppliedId
        : crypto.randomUUID();
    headers.set('x-mizar-operation-id', operationId);
    const taskId = headers.get('x-mizar-task-id');
    const trigger = headers.get('x-mizar-trigger') ?? 'unattributed';
    const parentOperationId = headers.get('x-mizar-parent-operation-id');
    controlEvidence('http_control', 'begin', {
      taskId,
      trigger,
      parentOperationId,
      operationId,
      method,
      route: url.pathname,
    });
    try {
      const response = await transport(input, { ...init, headers });
      controlEvidence('http_control', 'result', {
        taskId,
        trigger,
        parentOperationId,
        operationId,
        status: response.status,
      });
      return response;
    } catch (error) {
      controlEvidence('http_control', 'failure', {
        taskId,
        trigger,
        parentOperationId,
        operationId,
        error: browserErrorEvidence(error),
      });
      throw error;
    }
  };
}

// Polling reads are snapshots, not new user actions. Preserve changes and aggregate
// identical observations with first/last times and counts, then flush on export.
interface NativeSnapshot {
  signature: string;
  firstObservedAt: string;
  lastObservedAt: string;
  observations: number;
  result: unknown;
}
const nativeSnapshots = new Map<string, NativeSnapshot>();
function snapshotEvidence({
  firstObservedAt,
  lastObservedAt,
  observations,
  result,
}: NativeSnapshot) {
  return { firstObservedAt, lastObservedAt, observations, result };
}

export function nativeSnapshot(operation: string, result: unknown): void {
  try {
    const signature = JSON.stringify(result) ?? 'null';
    const previous = nativeSnapshots.get(operation);
    const now = new Date().toISOString();
    if (previous?.signature === signature) {
      previous.lastObservedAt = now;
      previous.observations++;
      return;
    }
    if (previous) controlEvidence(operation, 'snapshot_aggregate', snapshotEvidence(previous));
    const snapshot = {
      signature,
      firstObservedAt: now,
      lastObservedAt: now,
      observations: 1,
      result: JSON.parse(signature) as unknown,
    };
    nativeSnapshots.set(operation, snapshot);
    controlEvidence(operation, 'snapshot', snapshotEvidence(snapshot));
  } catch {
    controlEvidence(operation, 'snapshot_failed', { reason: 'unserializable_snapshot' });
  }
}
export function flushControlSnapshots(): void {
  for (const [operation, evidence] of nativeSnapshots)
    void sendControlEvidence(operation, 'snapshot_aggregate', snapshotEvidence(evidence));
}

/** Drain a fixed prefix only. A hung IPC or continuously arriving events cannot hold export. */
export async function flushControlEvidence(): Promise<DocumentHandoffCoverage> {
  const throughSequence = documentSequence;
  const transport = window.__TAURI_INTERNALS__ ? 'host' : 'http';
  const budgetMs = 3000;
  const deadline = performance.now() + budgetMs;
  const pending = () =>
    (transport === 'host'
      ? hostQueue.map((event) => event.sequence as number)
      : [...httpPending.keys()]
    ).filter((sequence) => sequence <= throughSequence);
  let stopReason: DocumentHandoffCoverage['stopReason'] = 'drained';
  let attempts = 0;
  while (pending().length) {
    if (attempts >= 16) {
      stopReason = 'attempt-limit';
      break;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      stopReason = 'deadline';
      break;
    }
    const before = pending().length;
    const delivery = Promise.resolve().then<unknown>(() =>
      transport === 'host'
        ? handoffHost()
        : Promise.allSettled(
            [...httpPending]
              .filter(([sequence]) => sequence <= throughSequence)
              .map(([, promise]) => promise),
          ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled: boolean;
    try {
      settled = await Promise.race([
        delivery.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    attempts++;
    if (!settled) {
      stopReason = 'deadline';
      break;
    }
    if (pending().length >= before) {
      stopReason = 'no-progress';
      break;
    }
  }
  const remaining = pending();
  return {
    documentId: browserDocumentId,
    throughSequence,
    observedAt: new Date().toISOString(),
    transport,
    stopReason,
    pendingRecords: remaining.length,
    firstPendingSequence: remaining.length ? remaining.reduce((a, b) => Math.min(a, b)) : null,
    lastPendingSequence: remaining.length ? remaining.reduce((a, b) => Math.max(a, b)) : null,
    // These cumulative counters include this document's lifetime through observedAt,
    // not just the selected export time range, and failed HTTP receipts may have committed.
    unconfirmedRecordsObserved: unconfirmedRecords,
    deliveryFailureAttemptsObserved: controlDeliveryFailures,
    budgetMs,
    attempts,
  };
}
