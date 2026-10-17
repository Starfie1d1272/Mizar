let controlDeliveryFailures = 0;
let browserDocumentId: string | null = null;

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
  try {
    browserDocumentId ??= crypto.randomUUID();
    const context =
      evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : {};
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [field, header] of [
      ['taskId', 'x-mizar-task-id'],
      ['operationId', 'x-mizar-operation-id'],
      ['parentOperationId', 'x-mizar-parent-operation-id'],
    ] as const) {
      const value = context[field];
      if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
        headers[header] = value;
    }
    if (context.trigger === 'user' || context.trigger === 'system')
      headers['x-mizar-trigger'] = context.trigger;
    return fetch('/debug/control-event', {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers,
      body: JSON.stringify({
        operation,
        phase,
        time: new Date().toISOString(),
        browserDocumentId,
        deliveryFailuresBefore: controlDeliveryFailures,
        evidence,
      }),
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok) controlDeliveryFailures++;
      })
      .catch(() => {
        controlDeliveryFailures++;
      });
  } catch {
    controlDeliveryFailures++;
    /* Diagnostics cannot change the operation. */
    return Promise.resolve();
  }
}

export function controlEvidence(operation: string, phase: string, evidence: unknown): void {
  void sendControlEvidence(operation, phase, evidence);
}

/** Observe controls inside Mizar only; never inspect arbitrary files or other applications. */
export function installControlJournal(): void {
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
export async function flushControlSnapshots(): Promise<void> {
  await Promise.allSettled(
    [...nativeSnapshots].map(([operation, evidence]) =>
      fetch('/debug/control-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation,
          phase: 'snapshot_aggregate',
          time: new Date().toISOString(),
          evidence: snapshotEvidence(evidence),
        }),
        signal: AbortSignal.timeout(2000),
      }),
    ),
  );
}
