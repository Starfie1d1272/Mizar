import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxClient } from './box-sync.mjs';

const { Response, AbortSignal, DOMException } = globalThis;
let output;
beforeEach(() => {
  vi.useFakeTimers();
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
