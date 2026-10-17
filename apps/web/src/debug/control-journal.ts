// Best effort local diagnostics. Failure is never allowed to change the product operation.
export function controlEvidence(operation: string, phase: string, evidence: unknown): void {
  void fetch('/debug/control-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation, phase, time: new Date().toISOString(), evidence }),
    keepalive: true,
  }).catch(() => undefined);
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
    const label = element.getAttribute('aria-label') ?? input.name ?? element.id;
    const sensitive =
      input.type === 'password' ||
      /password|passwd|token|secret|credential|api.?key|stream.?key/i.test(
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
    const operationId = crypto.randomUUID();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('x-mizar-operation-id', operationId);
    controlEvidence('http_control', 'begin', { operationId, method, route: url.pathname });
    try {
      const response = await transport(input, { ...init, headers });
      controlEvidence('http_control', 'result', { operationId, status: response.status });
      return response;
    } catch (error) {
      controlEvidence('http_control', 'failure', {
        operationId,
        reason:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      throw error;
    }
  };
}
