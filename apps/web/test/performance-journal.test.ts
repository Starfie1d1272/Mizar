// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { installControlJournal } from '../src/debug/control-journal';
import {
  flushPerformanceJournal,
  installPerformanceJournal,
  recordChannelConsumption,
} from '../src/debug/performance-journal';

it('distinguishes completed radar drawing from document frames and preserves original browser errors', async () => {
  vi.useFakeTimers();
  let now = 0;
  const frames: FrameRequestCallback[] = [];
  const events: { operation: string; evidence: Record<string, unknown> }[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    events.push(JSON.parse(init.body as string) as (typeof events)[number]);
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.body.innerHTML = '<div id="root"><canvas></canvas></div>';
  const canvas = document.querySelector('canvas')!;
  Object.assign(canvas.dataset, {
    radarSource: 'client',
    radarPaused: 'false',
    radarDrawnSequence: '10',
  });
  vi.spyOn(canvas, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  try {
    installControlJournal();
    installPerformanceJournal();
    const tick = async (sequence: number) => {
      now += 1000;
      recordChannelConsumption(
        'radar',
        1,
        'live',
        {
          channelSeq: sequence,
          cursor: {
            producerInstanceId: 'public-fixture',
            liveSessionId: null,
            runtimeSeq: sequence,
            programSourceGeneration: 1,
            programReceiveSequence: sequence,
            mapEpoch: 1,
          },
        },
        true,
      );
      frames.shift()!(now);
      await vi.advanceTimersByTimeAsync(1000);
    };
    for (let seq = 11; seq <= 15; seq++) await tick(seq);
    await flushPerformanceJournal('test');
    const window = events.find((event) => event.operation === 'browser_performance')!.evidence;
    expect(window.frames).toMatchObject({ callbacks: 5 });
    expect(window.surfaces).toMatchObject({
      observed: [{ drawnSequence: 10, receivedSequence: 15, stalled: true }],
    });
    // Completion resuming clears the condition; intentional pauses never become failures.
    canvas.dataset.radarDrawnSequence = '16';
    await tick(16);
    canvas.dataset.radarPaused = 'true';
    for (let seq = 17; seq <= 21; seq++) await tick(seq);
    await flushPerformanceJournal('paused');
    expect(events.at(-1)?.evidence.surfaces).toMatchObject({
      observed: [{ paused: true, stalled: false }],
    });
    const error = new Error('draw failed', { cause: new RangeError('negative radius') });
    globalThis.window.dispatchEvent(
      new ErrorEvent('error', {
        error,
        message: error.message,
        filename: location.origin + '/mizar.js',
      }),
    );
    expect(events.at(-1)).toMatchObject({
      operation: 'browser_error',
      evidence: {
        error: { name: 'Error', cause: { name: 'RangeError', message: 'negative radius' } },
      },
    });
    const beforeForeign = events.length;
    globalThis.window.dispatchEvent(
      new ErrorEvent('error', { error, filename: 'chrome-extension://private/content.js' }),
    );
    expect(events).toHaveLength(beforeForeign);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  }
});
