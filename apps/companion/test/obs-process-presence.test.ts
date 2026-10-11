import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isObsProcessRunning } from '../src/obs/config.js';

const mocks = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: unknown,
        callback: (error: Error | null, value: string) => void,
      ) => void
    >(),
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  mocks.execFile.mockReset();
});
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

function respond(value: string, error: Error | null = null) {
  mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
    callback(error, value);
  });
}

it('distinguishes a successful zero-process result from running OBS without reading installation configuration', async () => {
  respond('0\r\n');
  expect(await isObsProcessRunning()).toBe(false);
  respond('2\r\n');
  expect(await isObsProcessRunning()).toBe(true);
  expect(mocks.execFile).toHaveBeenCalledWith(
    'powershell.exe',
    expect.any(Array),
    expect.objectContaining({ timeout: 2000, windowsHide: true, maxBuffer: 4096 }),
    expect.any(Function),
  );
});

it('preserves query errors and refuses malformed counts instead of treating them as absence', async () => {
  const error = Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' });
  respond('', error);
  await expect(isObsProcessRunning()).rejects.toBe(error);
  for (const value of ['', 'NaN', '-1', '0\naccess denied', '9007199254740992']) {
    respond(value);
    await expect(isObsProcessRunning()).rejects.toThrow('response is invalid');
  }
});

it('does not assume absence on unsupported platforms', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  await expect(isObsProcessRunning()).rejects.toThrow('requires Windows');
  expect(mocks.execFile).not.toHaveBeenCalled();
});
