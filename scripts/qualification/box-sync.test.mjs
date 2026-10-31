import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { BoxClient, verifyStableReadbacks } from './box-sync.mjs';
import { curlMultipartUpload } from './box-curl-upload.mjs';

const { AbortController, AbortSignal, Blob, FormData, Response } = globalThis;

test('final readbacks start Core in first batch, join failures and cover every asset', async () => {
  const asset = (name) => ({ name, size: 1, sha256: 'a'.repeat(64) });
  const metadata = asset('machine-metadata.json');
  const core = asset('Mizar-v1.10.0-Windows-x64-Core-Setup.exe');
  const options = {
    identity: { version: '1.10.0' },
    bootstrap: { identity: asset('web.exe') },
    resources: [asset('pack.zip')],
    runtime: [metadata, core],
  };
  const paths = [];
  await verifyStableReadbacks({
    ...options,
    box: {
      hash: async (path) => {
        paths.push(path);
        return { size: 1, sha256: 'a'.repeat(64) };
      },
    },
  });
  assert.equal(paths.length, 4);
  assert.ok(paths[0].endsWith(core.name));
  assert.deepEqual(
    new Set(paths.map((path) => path.split('/').pop())),
    new Set([core.name, metadata.name, 'web.exe', 'pack.zip']),
  );
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const started = [];
  let settled = false;
  const failed = verifyStableReadbacks({
    ...options,
    box: {
      hash: async (path) => {
        started.push(path);
        if (path.endsWith(core.name)) throw new Error('failure');
        await pending;
        return { size: 1, sha256: 'a'.repeat(64) };
      },
    },
  }).finally(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(started.length, 3);
  assert.equal(settled, false);
  finish();
  await assert.rejects(failed, /failure/);
  assert.equal(started.length, 3);
});

function client(transport) {
  const box = new BoxClient('test-token', transport);
  box.api = async (_endpoint, _path, _method, _body, signal) => {
    assert.ok(signal);
    return 'https://box.example/upload';
  };
  box.temporaryUrl = (value) => new URL(value);
  return box;
}

test('retries only the zero-byte failed chunk and retains the successful prefix', async () => {
  const ranges = [];
  const box = client(async (_url, options) => {
    const range = options.headers['Content-Range'];
    ranges.push(range);
    if (ranges.length === 2)
      throw Object.assign(new Error('connection failed'), {
        code: 'BOX_CURL_FAILED',
        retrySafeUpload: true,
      });
    return Response.json(range.startsWith('bytes 2-') ? [{ name: 'payload' }] : { success: true });
  });
  await box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2);
  assert.deepEqual(ranges, ['bytes 0-1/4', 'bytes 2-3/4', 'bytes 2-3/4']);
});

test('uncertain chunk failure is not replayed', async () => {
  let calls = 0;
  const box = client(async () => {
    calls++;
    throw Object.assign(new Error('connection lost'), { code: 'BOX_CURL_FAILED' });
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2), {
    uploadOutcomeUnknown: true,
    retrySafeUpload: false,
  });
  assert.equal(calls, 1);
});

test('zero-byte retries stop after three attempts', async () => {
  let calls = 0;
  const box = client(async () => {
    calls++;
    throw Object.assign(new Error('connection failed'), {
      code: 'BOX_CURL_FAILED',
      retrySafeUpload: true,
    });
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('a')), {
    retrySafeUpload: true,
  });
  assert.equal(calls, 3);
});

test('each chunk has a fresh deadline while the whole upload remains bounded', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const ranges = [];
  const box = client(async (_url, options) => {
    ranges.push(options.headers['Content-Range']);
    now += 179000;
    return Response.json(ranges.length === 3 ? [{ name: 'payload' }] : { success: true });
  });
  await box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcdef'), 2);
  assert.deepEqual(ranges, ['bytes 0-1/6', 'bytes 2-3/6', 'bytes 4-5/6']);
  assert.ok(now > 180000);
});

test('the aggregate chunk upload deadline also stops further chunks', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const box = client(async () => {
    calls++;
    now += 180000;
    return Response.json({ success: true });
  });
  await assert.rejects(
    box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcdefghijkl'), 2),
    /预算已用完/,
  );
  assert.equal(calls, 5);
});

test('deadline abort during a chunk stops the transfer as an uncertain write', async (t) => {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let budgetSignals = 0;
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    if (milliseconds === 180000) {
      budgetSignals++;
      return controller.signal;
    }
    return timeout(milliseconds);
  });
  let calls = 0;
  const box = client(async (_url, options) => {
    calls++;
    controller.abort();
    options.signal.throwIfAborted();
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2), {
    uploadOutcomeUnknown: true,
    retrySafeUpload: false,
  });
  assert.ok(budgetSignals >= 1);
  assert.equal(calls, 1);
});

test('real curl TLS failure reports zero sent bytes as safe to retry', async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const form = new FormData();
    form.set('file', new Blob(['local']), 'local');
    await assert.rejects(
      curlMultipartUpload(`https://127.0.0.1:${server.address().port}/`, {
        body: form,
        signal: AbortSignal.timeout(5000),
      }),
      { code: 'BOX_CURL_FAILED', retrySafeUpload: true },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('partial or malformed curl metrics never authorize replay', async () => {
  for (const metrics of ['000 0 0 0 0 0 1 2 0', '000 0 0']) {
    const run = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          child.stdout.end(metrics);
          child.emit('close', 35);
          callback();
        },
      });
      child.kill = () => {};
      return child;
    };
    const form = new FormData();
    form.set('file', new Blob(['local']), 'local');
    await assert.rejects(
      curlMultipartUpload(
        'https://example.test/',
        { body: form, signal: AbortSignal.timeout(5000) },
        run,
      ),
      { code: 'BOX_CURL_FAILED', retrySafeUpload: false },
    );
  }
});

test('a timed-out zero-byte chunk retries with a fresh attempt signal', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timers = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    if (milliseconds === 180000) {
      const controller = new AbortController();
      timers.push(controller);
      return controller.signal;
    }
    return timeout(milliseconds);
  });
  const observedSignals = [];
  const box = client(async (_url, { signal }) => {
    observedSignals.push(signal);
    if (observedSignals.length === 1) {
      timers[0].abort();
      throw Object.assign(new Error('zero bytes sent'), {
        code: 'BOX_CURL_FAILED',
        retrySafeUpload: true,
        uploadTimedOut: true,
      });
    }
    assert.equal(signal.aborted, false);
    return Response.json([{ name: 'payload' }]);
  });
  await box.uploadChunks('/Archive/test', 'payload', Buffer.from('a'));
  assert.equal(observedSignals.length, 2);
  assert.notEqual(observedSignals[0], observedSignals[1]);
});

test('release asset deadline includes reading the body', async (t) => {
  const { downloadReleaseAsset } = await import('./box-sync.mjs');
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let bounded = false;
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    if (milliseconds === 180000) {
      bounded = true;
      return controller.signal;
    }
    return timeout(milliseconds);
  });
  const name = 'asset.json';
  const release = {
    assets: [
      {
        name,
        size: 1,
        digest: `sha256:${'0'.repeat(64)}`,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v1.10.0/${name}`,
      },
    ],
  };
  const transport = async (_url, { signal }) => ({
    ok: true,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(0);
        controller.abort();
        signal.throwIfAborted();
      },
    },
  });
  await assert.rejects(downloadReleaseAsset(release, 'v1.10.0', name, 100, transport), /超时/);
  assert.ok(bounded);
});

test('upload link and transfer share one 180-second attempt signal', async (t) => {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds) =>
    milliseconds === 180000 ? controller.signal : timeout(milliseconds),
  );
  let uploadCalls = 0;
  const box = client(async () => {
    uploadCalls++;
  });
  box.api = async (_endpoint, _path, _method, _body, signal) => {
    controller.abort();
    signal.throwIfAborted();
  };
  await assert.rejects(box.upload('/Archive/test', 'payload', Buffer.from('a')));
  assert.equal(uploadCalls, 0);
});

test('anonymous redirects and body share one download deadline', async (t) => {
  const { verifyPublicDownloads } = await import('./box-sync.mjs');
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds) =>
    milliseconds === 180000 ? controller.signal : timeout(milliseconds),
  );
  const signals = [];
  const identity = { name: 'Mizar.exe', size: 1, sha256: '0'.repeat(64) };
  const transport = async (_url, { signal }) => {
    signals.push(signal);
    if (signals.length === 1)
      return new Response(null, { status: 302, headers: { location: '/seafhttp/files/next' } });
    return {
      ok: true,
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.alloc(0);
          controller.abort();
          signal.throwIfAborted();
        },
      },
    };
  };
  await assert.rejects(
    verifyPublicDownloads(
      { bootstrap: { identity } },
      {
        readDirectory: async () => [{ name: identity.name, size: 1 }],
        transport,
      },
    ),
  );
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test('remote readback link and body share the 180-second deadline', async (t) => {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds) =>
    milliseconds === 180000 ? controller.signal : timeout(milliseconds),
  );
  const box = client();
  box.api = async (_endpoint, _path, _method, _body, signal) => {
    assert.equal(signal.aborted, false);
    controller.abort();
    return 'https://box.example/download';
  };
  let downloadCalls = 0;
  box.downloadTransport = async (_url, { signal }) => {
    downloadCalls++;
    signal.throwIfAborted();
  };
  await assert.rejects(box.hash('/Archive/payload'));
  assert.equal(downloadCalls, 0);
});

test('readback retries the link and body with a fresh 180-second deadline', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timers = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    if (milliseconds === 180000) {
      const controller = new AbortController();
      timers.push(controller);
      return controller.signal;
    }
    return timeout(milliseconds);
  });
  t.mock.method(Math, 'random', () => 0);
  let links = 0,
    downloads = 0;
  const box = client();
  box.api = async () => {
    links++;
    return 'https://box.example/download';
  };
  box.downloadTransport = async (_url, { signal }) => {
    downloads++;
    if (downloads === 1) {
      timers[0].abort();
      signal.throwIfAborted();
    }
    assert.equal(signal.aborted, false);
    return new Response(Buffer.from('ok'));
  };
  assert.deepEqual(await box.hash('/Archive/payload'), {
    size: 2,
    sha256: (await import('./box-sync.mjs')).digest(Buffer.from('ok')),
  });
  assert.equal(links, 2);
  assert.equal(downloads, 2);
});

test('upload-link timeout retries before any upload using a fresh deadline', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timers = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    if (milliseconds === 180000) {
      const controller = new AbortController();
      timers.push(controller);
      return controller.signal;
    }
    return timeout(milliseconds);
  });
  t.mock.method(Math, 'random', () => 0);
  let links = 0,
    uploads = 0;
  const box = client(async () => {
    uploads++;
    return Response.json([{ name: 'payload' }]);
  });
  box.api = async (_endpoint, _path, _method, _body, signal) => {
    links++;
    if (links === 1) {
      timers[0].abort();
      signal.throwIfAborted();
    }
    assert.equal(signal.aborted, false);
    return 'https://box.example/upload';
  };
  await box.upload('/Archive/test', 'payload', Buffer.from('a'));
  assert.equal(links, 2);
  assert.equal(uploads, 1);
});

test('an uncertain timed-out upload is reconciled but never replayed when absent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let uploads = 0;
  let reads = 0;
  const box = client(async () => {
    uploads++;
    throw Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
  });
  box.list = async () => {
    reads++;
    return [];
  };
  let settled = false;
  const result = box
    .upload('/Archive/test', 'payload', Buffer.from('a'))
    .then(
      () => ({ success: true }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  for (let i = 0; i < 20 && !settled; i++) {
    await setImmediate();
    t.mock.timers.tick(15000);
  }
  const outcome = await result;
  assert.equal(outcome.error?.uploadOutcomeUnknown, true);
  assert.ok(reads > 1);
  assert.equal(uploads, 1);
});

test('a timeout with proven zero bytes can retry after an absent destination', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  let uploads = 0;
  const box = client(async () => {
    uploads++;
    if (uploads === 1)
      throw Object.assign(new Error('connection timed out'), {
        code: 'ETIMEDOUT',
        retrySafeUpload: true,
      });
    return Response.json([{ name: 'payload' }]);
  });
  box.list = async () => [];
  await box.upload('/Archive/test', 'payload', Buffer.from('a'));
  assert.equal(uploads, 2);
});

test('readback transient failures use one retry owner and stop after three attempts', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  let calls = 0;
  const box = new BoxClient('test-token', undefined, async () => {
    calls++;
    return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
  });
  await assert.rejects(box.hash('/Archive/payload'), { retryableRead: true });
  assert.equal(calls, 3);
});
