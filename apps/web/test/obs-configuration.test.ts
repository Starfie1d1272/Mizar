// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() =>
  vi.fn<
    (command: string, args: { sessionId: string; executablePath?: string }) => Promise<unknown>
  >(),
);
vi.mock('../src/workspace/client', () => ({ desktopInvoke: invoke }));
import { beginObsConfiguration } from '../src/workspace/obs-client';
afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
});
describe('OBS configuration cleanup', () => {
  it('waits for a late launch and ends only that session once', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    invoke.mockResolvedValue({ reason: 'not_owned', message: '' });
    const session = beginObsConfiguration();
    const finished = session.finish();
    expect(session.finish()).toBe(finished);
    expect(invoke).not.toHaveBeenCalled();
    resolve(new Response(JSON.stringify({ executablePath: 'C:\\OBS\\obs64.exe' })));
    await finished;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'begin_obs_configuration',
      'finish_obs_configuration',
    ]);
    expect(invoke.mock.calls[1]![1].sessionId).toBe(invoke.mock.calls[0]![1].sessionId);
  });
  it('does not finish a failed launch or consume a newer session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ executablePath: 'C:\\OBS\\obs64.exe' }))),
    );
    invoke.mockImplementation((command) =>
      command === 'begin_obs_configuration'
        ? Promise.reject(new Error('launch failed'))
        : Promise.resolve({ reason: 'not_owned', message: '' }),
    );
    const failed = beginObsConfiguration();
    await expect(failed.finish()).rejects.toThrow('launch failed');
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['begin_obs_configuration']);
    invoke.mockResolvedValue({ reason: 'not_owned', message: '' });
    // Each request gets a fresh Response body.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ executablePath: 'C:\\OBS\\obs64.exe' }))),
      ),
    );
    const newer = beginObsConfiguration();
    await newer.finish();
    expect(invoke.mock.calls[1]![1].sessionId).not.toBe(invoke.mock.calls[0]![1].sessionId);
    expect(invoke.mock.calls[2]![1].sessionId).toBe(invoke.mock.calls[1]![1].sessionId);
  });
});
