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
it('coalesces dense volume changes under a slow response, keeps the latest volume ahead of lease, and lets STOP and a new audition bypass old work', async () => {
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
      const request = JSON.parse(init.body as string) as MusicPreviewRequest;
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
    act(() => root.render(<Harness />));
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
      current!.volume('waiting', 0.2);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      for (let i = 0; i <= 200; i++) current!.volume('waiting', i / 200);
      await Promise.resolve();
    });
    expect(sent.map((r) => r.action)).toEqual(['start', 'update']);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent.map((r) => r.action)).toEqual(['start', 'update', 'update', 'lease']);
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
    await act(async () => {
      for (let i = 0; i <= 200; i++) current!.volume('waiting', i / 250);
      await Promise.resolve();
    });
    const beforeStop = sent.length;
    await act(async () => current!.stop());
    expect(sent.length).toBe(beforeStop + 1);
    expect(sent.at(-1)?.action).toBe('stop');
    expect(playing).toBe(false);
    expect(current!.status).toBeNull();
    // The previous transport is still blocked: new intent must not wait behind its queue.
    await act(async () =>
      current!.start(
        'waiting',
        { ...spec, volume: 0.4 },
        {
          id: `${'b'.repeat(64)}.wav`,
          name: 'new.wav',
          startMs: 0,
          endMs: null,
        },
      ),
    );
    expect(sent.at(-1)?.action).toBe('start');
    expect(playing).toBe(true);
    expect(appliedVolume).toBe(0.4);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent.length).toBe(beforeStop + 2); // No old update or lease escaped STOP.
    expect(appliedVolume).toBe(0.4);
    expect(playing).toBe(true);
    expect(current!.error).toBe('');
    await act(async () => current!.stop());
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
