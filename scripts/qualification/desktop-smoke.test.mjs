import { describe, expect, it } from 'vitest';
import { assertDesktopLog, assertDesktopReady } from './desktop-smoke.mjs';

function ready() {
  return {
    processes: [
      { pid: 10, name: 'Mizar.exe', packagedNode: false },
      { pid: 11, name: 'node.exe', packagedNode: true },
    ],
    windows: [{ title: 'Mizar', className: 'Tauri', hwnd: 42, width: 1280, height: 860 }],
    consoles: [{ pid: 11, hwnd: 0, visible: false, attachError: 6 }],
  };
}

describe('normal Desktop smoke evidence', () => {
  it('cannot pass on Companion health or a hidden/empty/error window alone', () => {
    expect(() => assertDesktopReady(ready(), 10)).not.toThrow();
    expect(() => assertDesktopReady({ ...ready(), windows: [] }, 10)).toThrow('main HWND');
    for (const window of [
      { ...ready().windows[0], width: 0 },
      { ...ready().windows[0], height: 0 },
      { ...ready().windows[0], hwnd: 0 },
      { ...ready().windows[0], className: '#32770' },
    ]) {
      expect(() => assertDesktopReady({ ...ready(), windows: [window] }, 10)).toThrow('main HWND');
    }
    expect(() => assertDesktopReady({ ...ready(), processes: [] }, 10)).toThrow('Host exited');
  });

  it('requires completed shutdown in the same Desktop session, not only a zero exit code', () => {
    const artifact = { gitSha: 'a'.repeat(40), artifactSha256: 'b'.repeat(64) };
    const context = {
      pid: 10,
      artifact,
      stage: 'shutdown',
      result: 'success',
      startupSessionId: 'normal-start',
    };
    const entry = {
      ...artifact,
      schemaVersion: 1,
      pid: 10,
      startupSessionId: 'normal-start',
      time: '2026-10-02T00:00:00Z',
      os: 'windows',
      arch: 'x86_64',
      stage: 'shutdown',
      result: 'success',
    };
    expect(assertDesktopLog([entry], context)).toEqual(entry);
    expect(() => assertDesktopLog([], context)).toThrow('shutdown/success');
    expect(() => assertDesktopLog([{ ...entry, result: 'begin' }], context)).toThrow('missing');
    expect(() =>
      assertDesktopLog([{ ...entry, startupSessionId: 'stop-command' }], context),
    ).toThrow();
  });
});
