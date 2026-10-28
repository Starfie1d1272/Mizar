// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args?: { sessionId?: string; executablePath?: string; documentGeneration?: string },
    ) => Promise<unknown>
  >(),
);
vi.mock('../src/workspace/client', () => ({ desktopInvoke: invoke }));
import { beginObsConfiguration } from '../src/workspace/obs-client';
const context = { documentGeneration: '1', message: '' };
const done = { reason: 'not_owned', message: '' };
function successful(command: string) {
  return Promise.resolve(command === 'read_obs_configuration_context' ? context : done);
}
afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
});
describe('OBS configuration cleanup', () => {
  it('waits for a late launch and ends only that document session once', async () => {
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
    invoke.mockImplementation(successful);
    const session = beginObsConfiguration();
    const finished = session.finish();
    void session.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'read_obs_configuration_context',
    ]);
    resolve(new Response(JSON.stringify({ executablePath: 'C:\\OBS\\obs64.exe' })));
    await finished;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'read_obs_configuration_context',
      'begin_obs_configuration',
      'finish_obs_configuration',
    ]);
    expect(invoke.mock.calls[1]![1]?.documentGeneration).toBe('1');
    expect(invoke.mock.calls[1]![1]?.sessionId).toEqual(expect.any(String));
    expect(invoke.mock.calls[2]![1]?.sessionId).toBe(invoke.mock.calls[1]![1]?.sessionId);
  });
  it('keeps the original document generation through a delayed target lookup so Host can reject a stale begin', async () => {
    let resolve!: (response: Response) => void;
    let currentDocument = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    invoke.mockImplementation((command, args) => {
      if (command === 'read_obs_configuration_context')
        return Promise.resolve({ ...context, documentGeneration: currentDocument });
      if (command === 'begin_obs_configuration' && args?.documentGeneration !== currentDocument)
        return Promise.reject(new Error('stale document'));
      return Promise.resolve(done);
    });
    const old = beginObsConfiguration();
    await Promise.resolve();
    await Promise.resolve();
    currentDocument = '2';
    resolve(new Response(JSON.stringify({ executablePath: 'C:\\OBS\\obs64.exe' })));
    await expect(old.finish()).rejects.toThrow('stale document');
    expect(invoke.mock.calls[1]![1]?.documentGeneration).toBe('1');
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain('finish_obs_configuration');
  });
});
