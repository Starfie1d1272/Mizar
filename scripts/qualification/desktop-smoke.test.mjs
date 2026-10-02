import { describe, expect, it } from 'vitest';
import { assertDesktopLog, assertDesktopReady, assertNoNodeConsole } from './desktop-smoke.mjs';

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

  it('detects a visible Node console even when conhost owns its HWND', () => {
    const snapshot = ready();
    snapshot.consoles = [{ pid: 11, hwnd: 99, visible: true, attachError: 0 }];
    expect(() => assertNoNodeConsole(snapshot)).toThrow('visible console');
    expect(() => assertNoNodeConsole({ ...ready(), consoles: [] })).toThrow('not inspected');
    snapshot.consoles = [{ pid: 11, hwnd: 0, visible: false, attachError: 5 }];
    expect(() => assertNoNodeConsole(snapshot)).toThrow('Win32 5');
  });

  it('accepts the explicit tray-degraded main window without accepting error dialogs', () => {
    const snapshot = ready();
    snapshot.windows[0].title = 'Mizar · 托盘不可用，关闭主窗口将退出';
    expect(() => assertDesktopReady(snapshot, 10)).not.toThrow();
    snapshot.windows[0].className = '#32770';
    expect(() => assertDesktopReady(snapshot, 10)).toThrow('main HWND');
    snapshot.windows[0].className = 'Tauri';
    snapshot.windows[0].title = 'Mizar 启动失败';
    expect(() => assertDesktopReady(snapshot, 10)).toThrow('main HWND');
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

  it('requires the failed stage and original error to belong to this exact Host and artifact', () => {
    const artifact = { gitSha: 'a'.repeat(40), artifactSha256: 'b'.repeat(64) };
    const context = { pid: 10, artifact, stage: 'webview2_preflight', result: 'failure' };
    const entry = {
      ...artifact,
      schemaVersion: 1,
      pid: 10,
      startupSessionId: 'one-start',
      time: '2026-10-02T00:00:00Z',
      os: 'windows',
      arch: 'x86_64',
      stage: 'webview2_preflight',
      result: 'failure',
      error: 'original WebView2 failure',
    };
    expect(assertDesktopLog([entry], context)).toEqual(entry);
    expect(() => assertDesktopLog([{ ...entry, pid: 20 }], context)).toThrow('missing');
    expect(() => assertDesktopLog([{ ...entry, result: 'success' }], context)).toThrow('missing');
    expect(() =>
      assertDesktopLog([{ ...entry, artifactSha256: 'c'.repeat(64) }], context),
    ).toThrow();
    expect(() => assertDesktopLog([{ ...entry, error: undefined }], context)).toThrow('original');
    expect(() =>
      assertDesktopLog([entry], { ...context, startupSessionId: 'another-start' }),
    ).toThrow();
  });
});
