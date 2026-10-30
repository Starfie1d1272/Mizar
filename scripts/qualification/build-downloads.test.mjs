import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchResponse } from './build.mjs';
import { stageReleasedObserver } from './observer-component.mjs';

const { AbortController, AbortSignal, Response, ReadableStream } = globalThis;
test('runtime and observer download deadlines remain active during response bodies', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const controllers = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    if (milliseconds !== 180000) return timeout(milliseconds);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
          },
        }),
      ),
  );
  const response = await fetchResponse('https://example.test/runtime');
  const runtimeBody = response.arrayBuffer();
  controllers[0].abort();
  await assert.rejects(runtimeBody);
  const observer = stageReleasedObserver('/tmp/not-used', '/tmp/not-used');
  await new Promise((done) => globalThis.setImmediate(done));
  controllers[1].abort();
  await assert.rejects(observer);
  assert.equal(controllers.length, 2);
});
