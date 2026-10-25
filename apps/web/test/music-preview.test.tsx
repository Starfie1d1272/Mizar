// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultMusicConfig, type MusicPreviewRequest } from '@mizar/protocol/music';
import { useMusicPreview } from '../src/music/useMusicPreview';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('serializes a delayed volume update ahead of lease delivery, while STOP overtakes both and cannot be resurrected', async () => {
  vi.useFakeTimers();
  const sent: MusicPreviewRequest[] = [];
  let highWater = 0;
  let appliedVolume = 0;
  let playing = false;
  let release!: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as MusicPreviewRequest;
      sent.push(request);
      // This adversarial transport holds volume requests; any unqueued lease would arrive first.
      if (request.action === 'update') await gate;
      if (request.operation <= highWater)
        return Response.json({ error: 'music_preview_stale_operation' }, { status: 400 });
      highWater = request.operation;
      if (request.action === 'start' || request.action === 'update') appliedVolume = request.volume;
      if (request.action === 'start') playing = true;
      if (request.action === 'stop') playing = false;
      return Response.json({
        status: {
          preview: {
            owner: request.owner,
            token: request.token,
            group: request.group,
            phase: playing ? 'playing' : 'stopped',
            message: '',
          },
        },
      });
    }),
  );
  let current: ReturnType<typeof useMusicPreview> | null = null;
  function Harness() {
    current = useMusicPreview();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const spec = defaultMusicConfig().groups.waiting;
    await act(async () =>
      current!.start('waiting', spec, {
        id: `${'a'.repeat(64)}.wav`,
        name: 'synthetic.wav',
        startMs: 0,
        endMs: null,
      }),
    );
    await act(async () => {
      current!.volume('waiting', 1);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sent.map((r) => r.action)).toEqual(['start', 'update']);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent.map((r) => r.action)).toEqual(['start', 'update', 'lease']);
    expect(appliedVolume).toBe(1);
    expect(current!.error).toBe('');

    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      current!.volume('waiting', 0);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => current!.stop());
    expect(sent.at(-1)?.action).toBe('stop');
    expect(playing).toBe(false);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(appliedVolume).toBe(1); // The delayed, older update cannot overwrite STOP.
    expect(playing).toBe(false);
    expect(current!.status).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
