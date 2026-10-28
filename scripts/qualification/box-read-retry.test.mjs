import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxClient, digest } from './box-sync.mjs';
import { Buffer } from 'node:buffer';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms, value, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const abort = () => {
        globalThis.clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = globalThis.setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    }),
}));
const { Response, AbortSignal, DOMException } = globalThis;
let output;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.999999);
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ok = () => new Response(JSON.stringify({ repo_name: 'Mizar' }));
const client = (transport) => new BoxClient('PRIVATE-AUTH-TOKEN', undefined, transport);

describe('Box read request recovery', () => {
  it.each(['ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'])(
    'recovers a read after %s without exposing the original error',
    async (code) => {
      const transport = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('PRIVATE-ERROR-URL'), { code }))
        .mockResolvedValueOnce(ok());
      const pending = client(transport).api('repo-info');
      await vi.advanceTimersByTimeAsync(999);
      expect(transport).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ repo_name: 'Mizar' });
      expect(transport).toHaveBeenCalledTimes(2);
      const logs = output.mock.calls.flat().join('\n');
      expect(logs).toContain(code);
      expect(logs).not.toContain('PRIVATE-ERROR-URL');
      expect(logs).not.toContain('PRIVATE-AUTH-TOKEN');
    },
  );

  it('restarts the full hash after a response body socket failure', async () => {
    const error = Object.assign(new TypeError('PRIVATE-URL'), {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    const broken = new Response(
      new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue(new globalThis.TextEncoder().encode('partial'));
          controller.error(error);
        },
      }),
    );
    const download = vi
      .fn()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(new Response('complete'));
    const api = vi
      .fn()
      .mockResolvedValue(new Response('"https://box.nju.edu.cn/seafhttp/private"'));
    const box = new BoxClient('PRIVATE-TOKEN', undefined, api, download);
    const pending = box.hash('/Resources/v1.8.0/pack.zip');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ size: 8, sha256: digest(Buffer.from('complete')) });
    expect(download).toHaveBeenCalledTimes(2);
    expect(output.mock.calls.flat().join('\n')).not.toContain('PRIVATE-URL');
  });

  it('bounds an expired read to three independent request deadlines', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('PRIVATE-TIMEOUT', 'TimeoutError')),
    );
    const transport = vi.fn(async (_url, options) => options.signal.throwIfAborted());
    const pending = client(transport).api('download-link', '/Stable/old.exe');
    const rejected = expect(pending).rejects.toThrow('已尝试3次');
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(transport).toHaveBeenCalledTimes(3);
    expect(new Set(transport.mock.calls.map(([, options]) => options.signal)).size).toBe(3);
    expect(output.mock.calls.flat().join('\n')).not.toContain('PRIVATE-TIMEOUT');
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'releases a temporary HTTP %s response before retrying the read',
    async (status) => {
      const response = new Response('PRIVATE-RESPONSE', { status });
      const cancel = vi.spyOn(response.body, 'cancel');
      const transport = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(ok());
      const pending = client(transport).api('repo-info');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({ repo_name: 'Mizar' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(output.mock.calls.flat().join('\n')).not.toContain('PRIVATE-RESPONSE');
    },
  );

  it.each(['POST', 'DELETE'])('does not replay an uncertain %s mutation', async (method) => {
    const transport = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('PRIVATE-MUTATION'), { code: 'ETIMEDOUT' }));
    await expect(client(transport).api('file', '/Stable/item', method)).rejects.toThrow(
      '已尝试1次',
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('preserves the uncertain outcome through the copy API stage for reconciliation', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('PRIVATE'), { code: 'ETIMEDOUT' }));
    await expect(
      client(transport).copy('/Resources/v1.0.0', '/Resources/v1.1.0', 'pack.zip'),
    ).rejects.toMatchObject({ uploadOutcomeUnknown: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not replay a mutation rejected by a temporary server response', async () => {
    const transport = vi.fn(async () => new Response('PRIVATE-RESPONSE', { status: 503 }));
    await expect(client(transport).api('file', '/Stable/item', 'POST')).rejects.toMatchObject({
      httpStatus: 503,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 501])('keeps HTTP %s terminal for reads', async (status) => {
    const transport = vi.fn(async () => new Response('PRIVATE-RESPONSE', { status }));
    await expect(client(transport).api('repo-info')).rejects.toMatchObject({ httpStatus: status });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unknown error or invalid JSON', async () => {
    const unknown = vi.fn().mockRejectedValue(new Error('PRIVATE-ERROR-URL'));
    await expect(client(unknown).api('repo-info')).rejects.toThrow('network');
    expect(unknown).toHaveBeenCalledTimes(1);
    const invalid = vi.fn(async () => new Response('PRIVATE-INVALID-JSON'));
    await expect(client(invalid).api('repo-info')).rejects.toThrow('无效 JSON');
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});

describe('Box bounded recovery', () => {
  it.each(['seconds', 'date'])('honors Retry-After %s', async (header) => {
    vi.setSystemTime(new Date('2026-10-24T09:00:00Z'));
    header = header === 'seconds' ? '3' : new Date(Date.now() + 3000).toUTCString();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'Retry-After': header } }),
      )
      .mockResolvedValueOnce(ok());
    const pending = client(transport).api('repo-info');
    await vi.advanceTimersByTimeAsync(2999);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ repo_name: 'Mizar' });
  });
  it('stops rather than retrying before an excessive Retry-After', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503, headers: { 'Retry-After': '3600' } }));
    await expect(client(transport).api('repo-info')).rejects.toThrow('预算');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('uses a 20-second API deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await client(vi.fn().mockResolvedValue(ok())).api('repo-info');
    expect(timeout).toHaveBeenCalledWith(20000);
  });
  function uploading({ safe = true, entries = [], actual, status } = {}) {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('PRIVATE-UPLOAD'), {
          code: 'BOX_CURL_FAILED',
          retrySafeUpload: safe,
          httpStatus: status,
        }),
      )
      .mockResolvedValue(new Response('[{"name":"core.exe"}]'));
    const api = vi
      .fn()
      .mockImplementation(async () => new Response('"https://box.nju.edu.cn/seafhttp/PRIVATE"'));
    const box = new BoxClient('PRIVATE-TOKEN', transport, api);
    vi.spyOn(box, 'list').mockResolvedValue(entries);
    vi.spyOn(box, 'hash').mockResolvedValue(actual);
    return { box, transport, api };
  }
  const bytes = Buffer.from('core');
  it('retries an unsent upload only after confirming absence, with a fresh upload URL', async () => {
    const { box, transport, api } = uploading();
    const pending = box.upload('/Runtime/v1.6.4', 'core.exe', bytes);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(box.list).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('accepts a lost acknowledgement only after matching size and SHA', async () => {
    const { box, transport } = uploading({
      safe: false,
      entries: [{ name: 'core.exe', type: 'file' }],
      actual: { size: 4, sha256: digest(bytes) },
    });
    await box.upload('/Runtime/v1.6.4', 'core.exe', bytes);
    expect(box.hash).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('preserves a same-size different-content destination', async () => {
    const { box, transport } = uploading({
      entries: [{ name: 'core.exe', type: 'file' }],
      actual: { size: 4, sha256: digest(Buffer.from('nope')) },
    });
    await expect(box.upload('/Runtime/v1.6.4', 'core.exe', bytes)).rejects.toThrow('不同内容');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([{ safe: false }, { safe: true, replace: true }])(
    'does not replay uncertain/replace writes: %j',
    async ({ safe, replace }) => {
      const { box, transport } = uploading({ safe });
      await expect(box.upload('/Updates', 'core.exe', bytes, replace)).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps auth failure terminal even when upload metrics look retryable', async () => {
    const { box, transport } = uploading({ status: 403 });
    await expect(box.upload('/Runtime/v1.6.4', 'core.exe', bytes)).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(box.list).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('caps unsent upload attempts at three', async () => {
    const { box, transport } = uploading();
    transport
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('PRIVATE'), { code: 'BOX_CURL_FAILED', retrySafeUpload: true }),
      );
    const pending = box.upload('/Runtime/v1.6.4', 'core.exe', bytes);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(transport).toHaveBeenCalledTimes(3);
  });
});

it('cancels reconciliation at the same 15-minute upload budget', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new globalThis.AbortController();
    globalThis.setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
  const transport = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('lost'), { code: 'BOX_CURL_FAILED', retrySafeUpload: true }),
    );
  const box = new BoxClient(
    'private',
    transport,
    async () => new Response('"https://box.nju.edu.cn/seafhttp/private"'),
  );
  vi.spyOn(box, 'list').mockImplementation(
    (_path, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const pending = box.upload('/Runtime/v1.6.4', 'core.exe', Buffer.from('core'));
  const rejected = expect(pending).rejects.toThrow('timeout');
  await vi.advanceTimersByTimeAsync(900000);
  await rejected;
  expect(transport).toHaveBeenCalledTimes(1);
});
