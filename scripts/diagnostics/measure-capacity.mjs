import { DatabaseSync } from 'node:sqlite';
import { meteredRuntime } from './capacity-runtime.mjs';
import { fullOutbox } from './outbox-capacity.mjs';
/** Reproducible public synthetic qualification; never connects to a Cloudflare account. */
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { strict as assert } from 'node:assert';
import { setImmediate as yieldIO, setTimeout as waitForIO } from 'node:timers/promises';
import { buildApp } from '../../apps/companion/src/app.ts';
import {
  WorkspaceObserver,
  registerWorkspaceObserver,
} from '../../apps/companion/src/telemetry/observer-workspace.ts';
import { CameraDirector } from '../../apps/companion/src/orchestration/director.ts';
import { OrchestrationStore } from '../../apps/companion/src/orchestration/store.ts';
import { MulnxProvider } from '../../apps/companion/src/orchestration/provider.ts';
import { registerOrchestrationRoutes } from '../../apps/companion/src/orchestration/routes.ts';
import { MusicStore } from '../../apps/companion/src/music/store.ts';
import { createLocalWebOriginPolicy } from '../../apps/companion/src/local-web/origin-policy.ts';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.ts';
import {
  DiagnosticDelivery,
  DELIVERY_LIMITS,
  decodeDiagnosticBatch,
} from '../../apps/companion/src/support/delivery.ts';
import { runtime, migrate, bindings } from '../../tests/diagnostics/fixture.ts';
import {
  stampDiagnosticGzip,
  diagnosticGzipCreatedAt,
  readDiagnosticGzipPermit,
} from '../../packages/protocol/src/diagnostics-upload.ts';
const { fetch, Headers, structuredClone } = globalThis;
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/capacity-producers.json', import.meta.url), 'utf8'),
);

async function profile(directory) {
  const root = await mkdtemp(join(directory, 'profile-'));
  const consoleEntry = fixture.consoleEntry;
  const consoleDetail = JSON.parse(consoleEntry.detail);
  const normal = consoleDetail.records.find((x) => !x.failureKind);
  const failure = consoleDetail.records.find((x) => x.failureKind);
  assert(normal && failure);
  const logs = join(root, 'logs');
  const journal = new SessionJournal(logs, {
    appVersion: '1.4.0',
    hostStartupSessionId: 'capacity-public-host',
  });
  await journal.flush();
  const sourceDirectory = join(root, 'host');
  await mkdir(sourceDirectory);
  let virtual = 0;
  let utc = Date.now();
  const epoch = utc;
  const delivery = await new DiagnosticDelivery(logs, journal, {
    endpoint: 'https://capacity.invalid',
    now: () => utc,
  }).initialize(false);
  await delivery.consent(true);
  await delivery.pause(true);
  let frames = 0,
    browser = 0,
    http = 0,
    renewals = 0,
    nativeOps = 0,
    technicalLines = 0;
  const app = buildApp({
    supportJournal: journal,
    supportLogsDirectory: sourceDirectory,
    gsiToken: 'public-capacity',
    clock: {
      now: () => ({ receivedAt: new Date(utc).toISOString(), receivedMonotonicMs: virtual }),
    },
    debugClock: { nowMonotonicMs: () => virtual },
    onAcceptedRaw: () => {
      frames++;
    },
  });
  // Exercise the actual renewal POST handlers and native lease. No game or
  // observer process is launched; GSI and source records remain synthetic.
  const observer = new WorkspaceObserver(async () => {
    throw new Error('capacity_no_process_launch');
  });
  const controlToken = 'public-capacity-control';
  registerWorkspaceObserver(app, observer, controlToken);
  const provider = new MulnxProvider();
  const camera = new CameraDirector(
    new OrchestrationStore(join(root, 'camera')),
    provider,
    () => {
      throw new Error('capacity_renewal_must_not_execute_camera');
    },
    undefined,
    () => virtual,
  );
  registerOrchestrationRoutes(
    app,
    camera,
    new MusicStore(join(root, 'music')),
    createLocalWebOriginPolicy(),
    { controlToken, configure: (_revision, commit) => commit() },
  );
  app.addHook('onClose', async () => {
    await observer.close();
    provider.close();
  });
  await app.ready();
  const nativeHeaders = { 'x-runtime-token': controlToken };
  const cameraRoute = '/operator/runtime/camera-session';
  const host = 'public-capacity-host';
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: cameraRoute,
        headers: nativeHeaders,
        payload: { action: 'host-start', host },
      })
    ).statusCode,
    200,
  );
  const begin = await app.inject({
    method: 'POST',
    url: cameraRoute,
    headers: nativeHeaders,
    payload: { action: 'begin', host, expectedRevision: 'public' },
  });
  assert.equal(begin.statusCode, 200);
  const lease = begin.json().lease;
  const payload = {
    auth: { token: 'public-capacity' },
    provider: {
      name: 'Counter-Strike 2',
      appid: 730,
      steamid: '76561198000000000',
      timestamp: epoch / 1000,
    },
    map: {
      name: 'de_ancient',
      mode: 'competitive',
      phase: 'live',
      round: 10,
      team_ct: { score: 5 },
      team_t: { score: 4 },
    },
    round: { phase: 'live' },
    phase_countdowns: { phase: 'live', phase_ends_in: '50.0' },
    player: {
      steamid: '76561198000000001',
      team: 'CT',
      activity: 'playing',
      state: { health: 100, armor: 100 },
    },
    allplayers: Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        String(76561198000000000n + BigInt(i)),
        {
          name: 'Public Player ' + i,
          position: `${i * 100},200,300`,
          team: i < 8 ? 'CT' : 'T',
          observer_slot: i,
          state: { health: 100, armor: 100, flashed: 0, smoked: 0, burning: 0 },
          match_stats: { kills: 10, assists: 3, deaths: 9, mvps: 0, score: 20 },
        },
      ]),
    ),
  };
  const runtimeTemplate = fixture.runtime;
  const durations = [];
  const start = performance.now();
  try {
    for (let sequence = 0; sequence < 144000; sequence++) {
      virtual = sequence * 50;
      utc = epoch + virtual;
      payload.provider.timestamp = utc / 1000;
      for (const [index, player] of Object.values(payload.allplayers).entries()) {
        player.position = `${((sequence * 17 + index * 137) % 7000) - 3500},${((sequence * 11 + index * 331) % 7000) - 3500},${(index % 3) * 64}`;
        player.state.health = 100 - ((Math.floor(sequence / 60) + index) % 70);
      }
      const before = performance.now();
      const response = await app.inject({
        headers: { origin: 'http://127.0.0.1:3000' },
        method: 'POST',
        url: '/gsi',
        payload,
      });
      assert.equal(response.statusCode, 204);
      durations.push(performance.now() - before);
      if (sequence % 40 === 0) {
        for (const [url, body] of [
          ['/operator/runtime/observer', { action: 'pulse' }],
          [cameraRoute, { action: 'pulse', host, lease }],
        ]) {
          const renewed = await app.inject({
            method: 'POST',
            url,
            headers: nativeHeaders,
            payload: body,
          });
          assert.equal(renewed.statusCode, 200, renewed.body);
          renewals++;
        }
      }
      if (sequence % 10 === 0) {
        assert.equal(
          (
            await app.inject({
              headers: { origin: 'http://127.0.0.1:3000' },
              method: 'GET',
              url: '/local/v1/diagnostics/delivery',
            })
          ).statusCode,
          200,
        );
        http++;
      }
      if (sequence % 150 === 0) {
        assert.equal(
          (
            await app.inject({
              headers: { origin: 'http://127.0.0.1:3000' },
              method: 'POST',
              url: '/debug/control-event',
              payload: {
                operation: 'browser_performance',
                time: new Date(utc).toISOString(),
                browserDocumentId: 'public-document',
                evidence: {
                  raf: { count: 450, maxGapMs: 18 },
                  channels: [{ channel: 'radar', accepted: 150, maxHandleMs: 2 }],
                  anomalyCount: 0,
                  anomalies: [],
                },
              },
            })
          ).statusCode,
          204,
        );
        browser++;
      }
      if (sequence % 12000 === 600) {
        assert.equal(
          (
            await app.inject({
              headers: { origin: 'http://127.0.0.1:3000' },
              method: 'POST',
              url: '/debug/control-event',
              payload: {
                operation: 'browser_error',
                time: new Date(utc).toISOString(),
                browserDocumentId: 'public-document',
                result: 'failed',
                evidence: {
                  error: {
                    message: 'public synthetic render error',
                    cause: { message: 'original capacity cause' },
                  },
                },
              },
            })
          ).statusCode,
          204,
        );
      }
      if (sequence % 20 === 0) {
        const lower = new Date(utc).toISOString(),
          upper = new Date(utc + 1).toISOString();
        const item = {
          ...(sequence % 12000 === 600 ? failure : normal),
          sourceRecordId: createHash('sha256')
            .update('public-' + sequence)
            .digest('hex'),
          sourceAfterUtc: lower,
          capturedAt: upper,
        };
        item.text += ` frame=${sequence} allocation=${(sequence * 7919) % 1000003} latencyMs=${sequence % 43}`;
        item.sourceBytes = Buffer.byteLength(item.text) + 1;
        item.sourceOffset = sequence * 256;
        const detail = { ...consoleDetail, records: [item] };
        await appendFile(
          join(sourceDirectory, 'desktop.ndjson'),
          JSON.stringify({
            ...consoleEntry,
            time: upper,
            startupSessionId: 'capacity-public-host',
            detail: JSON.stringify(detail),
          }) + '\n',
        );
        technicalLines++;
      }
      if (sequence % 300 === 0) {
        const runtime = structuredClone(runtimeTemplate);
        runtime.reason = 'modeled-15s-interval-from-public-production-fixture';
        runtime.windowMs = 15000;
        runtime.input.raw = {
          sequence,
          receivedAt: new Date(utc).toISOString(),
          receivedMonotonicMs: virtual,
        };
        runtime.input.normalized = runtime.input.raw;
        runtime.processing.count = 300;
        for (const channel of runtime.channels) {
          channel.channelSeq = sequence;
          if (channel.cursor) channel.cursor.programReceiveSequence = sequence;
        }
        journal.record('runtime_performance_window', runtime);
      }
      if (sequence % 400 === 0) {
        const taskId = randomUUID();
        for (const stage of [
          'cs2_launch_arguments',
          'workspace_exit_production_finish',
          'workspace_exit_cs2_finish',
          'workspace_exit_eligibility',
          'workspace_exit_window_feedback',
          'workspace_exit_present',
          'workspace_exit_completed',
        ])
          await appendFile(
            join(sourceDirectory, 'desktop.ndjson'),
            JSON.stringify({
              schemaVersion: 1,
              time: new Date(utc).toISOString(),
              startupSessionId: 'capacity-public-host',
              stage,
              result: stage.endsWith('completed') ? 'success' : 'begin',
              taskId,
              trigger: 'user',
              detail: JSON.stringify({
                arguments: ['-applaunch', '730', '-worldwide', '-condebug'],
                argumentsScope: 'requested-steam-command',
                before: { workspace: 'active' },
                after: { workspace: stage.endsWith('completed') ? 'idle' : 'waiting' },
              }),
            }) + '\n',
          );
        nativeOps++;
      }
      if (sequence % 1200 === 1199) {
        // The producer clock advances 60 seconds while NativeSource's real timer
        // does not. Observe its durable cursor reaching this input boundary;
        // otherwise a fast CI host closes with unread source bytes and measures
        // an incomplete workload. No extra collector or export is substituted.
        const sourceBytes = (await stat(join(sourceDirectory, 'desktop.ndjson'))).size;
        const deadline = performance.now() + 5000;
        for (;;) {
          const cursor = await readFile(join(sourceDirectory, 'native-source-cursor.json'), 'utf8')
            .then(JSON.parse)
            .catch((error) => {
              if (error.code === 'ENOENT') return { cursors: [] };
              throw error;
            });
          if (cursor.cursors.some((entry) => entry.offset === sourceBytes)) break;
          assert(performance.now() < deadline, 'actual NativeSource did not commit minute input');
          await waitForIO(50);
        }
        await journal.flush();
        await delivery.tick(false);
        if (sequence % 12000 === 11999)
          console.error(
            JSON.stringify({ minute: Math.floor(sequence / 1200) + 1, status: delivery.status() }),
          );
      }
      if (sequence % 20 === 19) await yieldIO();
    }
    await app.close();
    await delivery.close();
    const state = JSON.parse(await readFile(join(logs, 'diagnostic-outbox/state.json'), 'utf8'));
    const packets = [];
    const stages = {};
    let nativeHealth = null,
      performanceHealth = null;
    let expanded = 0,
      gzipBytes = 0,
      events = 0,
      consoleRecords = 0,
      anomalySamples = 0;
    for (const item of state.queue) {
      const bytes = await readFile(join(logs, 'diagnostic-outbox', item.id + '.gz'));
      const decoded = await decodeDiagnosticBatch(bytes);
      expanded += Buffer.byteLength(JSON.stringify(decoded));
      gzipBytes += bytes.length;
      events += decoded.events.length;
      for (const e of decoded.events) {
        stages[e.stage] = (stages[e.stage] ?? 0) + 1;
        if (e.stage === 'native_source_health') nativeHealth = e.evidence;
        if (e.stage === 'performance_context_health') performanceHealth = e.evidence;
        if (e.stage === 'performance_anomaly_samples')
          anomalySamples += e.evidence.samples?.length ?? 0;
        if (e.stage === 'native_host_records')
          for (const x of e.evidence.entries ?? [])
            if (x.entry.stage === 'cs2_console_records')
              consoleRecords += JSON.parse(x.entry.detail).records.length;
      }
      packets.push({ id: item.id, index: item.index, bytes: bytes.toString('base64') });
    }
    durations.sort((a, b) => a - b);
    const output = {
      schema: 'mizar-final-collector-capacity/1',
      scope:
        'actual buildApp HTTP/GSI/browser collectors, performance window and durable spool plus app-owned NativeSource; real journal/disk/outbox; isolated injected journal root keeps the app-internal off-by-default uploader separate from the metered outbox; native input scales a real Rust-produced public fixture and runtime aggregates scale an actual public production snapshot at modeled rates, not 100 real games; accelerated time, IO catch-up each virtual minute; no account requests; no inference of game FPS or cloud CPU',
      minutes: 120,
      epoch,
      rates: {
        gsiHz: 20,
        players: 16,
        inputVariation:
          'changing positions, health, publication counters and technical line counters',
        ownReadsPerMinute: 120,
        nativeRenewalsPerMinute: 60,
        browserAggregatesPerMinute: 8,
        nativeOperationsPerMinute: 3,
        technicalConsoleLinesPerSecond: 1,
        browserFaultsPerTenMinutes: 1,
        runtimeAggregatesPerMinute: 4,
      },
      frames,
      http,
      renewals,
      browser,
      nativeOps,
      technicalLines,
      consoleRecords,
      anomalySamples,
      events,
      stages,
      expanded,
      gzipBytes,
      batches: packets.length,
      manifestBytes: Buffer.byteLength(JSON.stringify(state)),
      outbox: delivery.status(),
      journal: journal.health(),
      native: nativeHealth,
      performanceContext: performanceHealth,
      wallMs: performance.now() - start,
      httpGsiMs: {
        p50: durations[Math.floor(durations.length * 0.5)],
        p99: durations[Math.floor(durations.length * 0.99)],
        max: durations.at(-1),
      },
    };
    assert.equal(frames, 144000);
    assert.equal(http, 14400);
    assert.equal(browser, 960);
    assert.equal(nativeOps, 360);
    assert.equal(consoleRecords, 7200);
    assert.equal(nativeHealth.copied, 9720);
    assert.equal(nativeHealth.failures, 0);
    assert.equal(nativeHealth.gaps, 0);
    assert.equal(nativeHealth.invalidRecords, 0);
    assert.equal(nativeHealth.backlogBytes, 0);
    assert.equal(journal.health().dropped, 0);
    assert.equal(journal.health().writeFailures, 0);
    assert.equal(performanceHealth.coverage.omittedRecords, 0);
    assert.equal(performanceHealth.coverage.omittedContextSamples, 0);
    assert.equal(performanceHealth.writeFailures, 0);
    assert.equal(delivery.status().omitted, 0);
    assert.equal(delivery.status().pendingBytes, 0);
    return { report: output, packets };
  } finally {
    await app.close();
    await delivery.close();
    await journal.close();
  }
}

/** Restore fixtures produced by the actual collector into the actual on-disk
 * outbox format, then use only production initialize/tick/ACK/restart behavior.
 * Cloning once per modeled session avoids recompressing the same public story
 * for 100 machines; ownership is distinct and raw MTIME/SHA are set once. */
async function cloud(directory, profileResult, faultResult) {
  const root = await mkdtemp(join(directory, 'outbox-days-'));
  const mf = meteredRuntime(join(root, 'server'));
  const endpoint = (await mf.ready).origin;
  const db = await mf.getD1Database('DIAGNOSTICS_DB');
  await migrate(db);
  const dayMs = 86400_000;
  const epoch = Math.floor(Date.now() / dayMs) * dayMs;
  let now = epoch;
  let accepting = true;
  let lostAck = true;
  const clients = [];
  const expected = new Set();
  const received = new Set();
  const offeredBytesByDay = [];
  const minuteRequests = new Map();
  const snapshots = [];
  const checkpoints = [];
  const days = [];
  const auditedSessions = new Set();
  const receivedPayloads = new Map();
  const sourceEpoch = profileResult.report.epoch;
  const control = async () => {
    const response = await fetch(endpoint + '/__test/control', {
      method: 'POST',
      body: JSON.stringify({ now, accepting }),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  const metrics = async () => (await fetch(endpoint + '/__test/metrics')).json();
  const subtract = (a, b) =>
    Object.fromEntries(Object.keys(a).map((key) => [key, a[key] - b[key]]));
  const fileState = async (client) =>
    JSON.parse(await readFile(join(client.path, 'diagnostic-outbox/state.json'), 'utf8'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const open = async (client) => {
    client.journal ??= new SessionJournal(client.path, { appVersion: 'capacity-public' });
    client.delivery = await new DiagnosticDelivery(client.path, client.journal, {
      endpoint,
      allowTestEndpoint: true,
      now: () => now,
      fetch: async (input, init) => {
        const path = new URL(input).pathname;
        const minute = Math.floor((now - epoch) / 60_000);
        const rate = minuteRequests.get(minute) ?? { enroll: 0, other: 0 };
        rate[path.endsWith('/enroll') ? 'enroll' : 'other']++;
        minuteRequests.set(minute, rate);
        const headers = new Headers(init.headers);
        headers.set('cf-connecting-ip', '192.0.2.7');
        const response = await fetch(input, { ...init, headers });
        if (init.method === 'PUT' && response.ok) {
          const permit = readDiagnosticGzipPermit(new Uint8Array(init.body));
          assert(permit);
          assert.equal(hash(permit.payload), permit.permit.payloadSha256);
          const key = client.index + '|' + permit.permit.payloadSha256;
          received.add(key);
          const wireHash = hash(init.body);
          const prior = receivedPayloads.get(key);
          const locator = await db
            .prepare('SELECT received_at,expires_at FROM batches WHERE installation_id=? AND id=?')
            .bind(permit.permit.installationId, wireHash)
            .first();
          if (prior)
            assert.deepEqual(locator, prior, 'lost ACK retry changed the original retention clock');
          else receivedPayloads.set(key, locator);
          const index = JSON.parse(headers.get('x-diagnostics-index'));
          const auditKey = client.index + '|' + index.sessionId;
          if (!auditedSessions.has(auditKey)) {
            const audit = await fetch(
              endpoint + '/admin/bodies/' + permit.permit.installationId + '/' + wireHash,
              { headers: { authorization: 'Bearer ' + bindings.ADMIN_KEY } },
            );
            assert.equal(audit.status, 200);
            assert(
              Buffer.from(await audit.arrayBuffer()).equals(Buffer.from(init.body)),
              'HTTP body read changed the sealed source bytes',
            );
            auditedSessions.add(auditKey);
          }
          if (lostAck) {
            lostAck = false;
            await response.arrayBuffer();
            throw new TypeError('public multi-day lost ACK after durable commit');
          }
        }
        return response;
      },
    }).initialize(false);
  };
  const close = async (client) => {
    if (client.delivery) {
      await client.delivery.close();
      await client.journal.close();
      client.delivery = null;
      client.journal = null;
    }
  };
  const fingerprint = async (client) => {
    const state = await fileState(client);
    const ids = [];
    for (const item of state.queue) {
      const bytes = await readFile(join(client.path, 'diagnostic-outbox', item.id + '.gz'));
      assert.equal(hash(bytes), item.id);
      ids.push(item.id);
    }
    return ids;
  };
  const restart = async (client) => {
    await close(client);
    const before = await fingerprint(client);
    await open(client);
    const after = new Set(await fingerprint(client));
    assert(
      before.every((id) => after.has(id)),
      'restart discarded or changed an unacknowledged wire SHA',
    );
  };
  const prototypes = async (day) => {
    const result = [];
    for (let session = 0; session < 4; session++) {
      const original = session === 3 ? faultResult : profileResult;
      const scope = `public-day-${day}-session-${session}`;
      const target = epoch + day * dayMs + session * 2 * 3600_000;
      const offset = target - (original.report.epoch ?? sourceEpoch);
      const identifiers = new Map();
      const id = (value) => {
        if (!identifiers.has(value)) identifiers.set(value, randomUUID());
        return identifiers.get(value);
      };
      const project = (value, key = '') => {
        if (typeof value === 'string') {
          if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
            return new Date(Date.parse(value) + offset).toISOString();
          if (key === 'detail' && (value.startsWith('{') || value.startsWith('['))) {
            try {
              return JSON.stringify(project(JSON.parse(value)));
            } catch {
              return value;
            }
          }
          if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) return id(value);
          if (['sourceRecordId', 'groupId'].includes(key)) return hash(scope + '|' + value);
          return value;
        }
        if (Array.isArray(value)) return value.map((item) => project(item));
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, project(item, name)]),
          );
        return value;
      };
      for (const packet of original.packets) {
        const body = project(
          JSON.parse(gunzipSync(Buffer.from(packet.bytes, 'base64')).toString()),
        );
        const plain = Buffer.from(JSON.stringify(body));
        const raw = gzipSync(plain);
        assert(raw.length + 1024 <= DELIVERY_LIMITS.compressedBytes);
        assert(plain.length <= DELIVERY_LIMITS.expandedBytes);
        const index = {
          ...project(packet.index),
          sessionId: body.events[0].startupSessionId,
          expandedBytes: plain.length,
        };
        const originalTime = diagnosticGzipCreatedAt(Buffer.from(packet.bytes, 'base64'));
        const createdAt =
          target + Math.max(0, originalTime - (original.report.epoch ?? sourceEpoch));
        result.push({ raw, index, createdAt });
      }
    }
    return result;
  };
  const loadDay = async (client, model, day) => {
    // Suspend just the sender while loading the recovery fixture. Avoid
    // manufacturing a second process restart on every ordinary modeled day.
    if (client.delivery) {
      await client.delivery.close();
      client.delivery = null;
    }
    const state = await fileState(client);
    for (const packet of model) {
      const bytes = Buffer.from(
        stampDiagnosticGzip(
          packet.raw,
          Math.floor(packet.createdAt / 1000) * 1000 + client.index * 1000,
        ),
      );
      const id = hash(bytes);
      const key = client.index + '|' + id;
      assert(!expected.has(key));
      expected.add(key);
      offeredBytesByDay[day] = (offeredBytesByDay[day] ?? 0) + bytes.length + 1024;
      state.queue.push({ id, bytes: bytes.length, index: packet.index });
      await writeFile(join(client.path, 'diagnostic-outbox', id + '.gz'), bytes);
    }
    // Production initialize validates these same bounds; do not import beyond
    // them, evict old entries, or put a refusal in an independent spill directory.
    assert(state.queue.length <= 2048);
    assert(state.queue.reduce((sum, b) => sum + b.bytes + 1024, 0) <= 64 * 1024 * 1024);
    assert(Buffer.byteLength(JSON.stringify(state)) <= 2 * 1024 * 1024);
    await writeFile(join(client.path, 'diagnostic-outbox/state.json'), JSON.stringify(state));
    await open(client);
    if (client.delivery.status().paused) await client.delivery.pause(false);
  };
  const pending = (group) =>
    group.reduce((sum, client) => sum + client.delivery.status().queuedBatches, 0);
  const drain = async (group, minutes) => {
    const deadline = now + minutes * 60_000;
    let position = 0;
    while (pending(group) && now < deadline) {
      await control();
      const chunk = [];
      for (let n = 0; n < Math.min(12, group.length); n++)
        chunk.push(group[position++ % group.length]);
      await Promise.all(chunk.map((client) => client.delivery.tick(false)));
      now += 5000;
      // Once everybody has been visited, honor the production backoff rather
      // than hammering rejected packets or resetting nextAttemptAt by hand.
      if (position >= group.length) {
        position %= group.length;
        const due = group
          .filter((c) => c.delivery.status().queuedBatches)
          .map((c) => c.delivery.status().nextAttemptAt);
        if (due.length && Math.min(...due) > now)
          now = Math.ceil(Math.min(deadline, Math.min(...due)));
      }
    }
    await control();
  };
  try {
    await control();
    for (let index = 0; index < 100; index++) {
      const client = {
        index,
        path: join(root, 'clients', String(index)),
        journal: null,
        delivery: null,
      };
      await mkdir(client.path, { recursive: true });
      await open(client);
      await client.delivery.consent(true);
      await client.delivery.pause(true);
      await close(client);
      clients.push(client);
    }
    const baseline = await metrics();
    const normalModel = await prototypes(0);
    const modeledBytesPerUserDay = normalModel.reduce((n, p) => n + p.raw.length + 1024, 0);
    assert(
      normalModel.length * 100 < 4800 * 0.8,
      'normal plus fault load needs at least 20% batch headroom',
    );
    assert(
      modeledBytesPerUserDay * 100 < 1073741824 * 0.8,
      'normal plus fault load needs at least 20% byte headroom',
    );
    now = epoch + 7 * 3600_000;
    for (const size of [10, 30, 100]) {
      const previous = size === 10 ? 0 : size === 30 ? 10 : 30;
      const added = clients.slice(previous, size);
      for (const client of added) await loadDay(client, normalModel, 0);
      if (size === 10) {
        accepting = false;
        await control();
        await drain(added, 5);
        assert(pending(added) > 0);
        for (const client of added) await restart(client);
        snapshots.push({
          reason: 'five-minute actual receiver refusal and restart',
          users: 10,
          unacknowledgedWireShaPreserved: true,
        });
        accepting = true;
        await control();
      }
      await drain(added, 90);
      assert.equal(pending(added), 0, 'healthy daily cohort did not drain');
      checkpoints.push({
        users: size,
        offeredSessionsPerUser: 4,
        hoursPerUser: 6,
        backlog: 0,
        total: subtract(await metrics(), baseline),
      });
      console.error(JSON.stringify({ productionOutboxCheckpoint: checkpoints.at(-1) }));
    }
    const healthyCost = checkpoints.at(-1).total;
    days.push({
      day: 0,
      receiver: 'healthy after five-minute refusal',
      queued: 0,
      cost: healthyCost,
    });
    // Two outage days, then continued ordinary use through bounded catch-up.
    let consecutiveDrainedDays = 0;
    for (let day = 1; day <= 12 && consecutiveDrainedDays < 2; day++) {
      now = epoch + day * dayMs + 7 * 3600_000;
      accepting = day > 2;
      await control();
      const model = await prototypes(day);
      const before = await metrics();
      for (const client of clients) await loadDay(client, model, day);
      if (day <= 2) {
        await drain(clients, 12 * 60);
        assert(pending(clients) > 0);
      } else await drain(clients, 12 * 60);
      let bytes = 0,
        maxBytes = 0,
        maxBatches = 0;
      for (const client of clients) {
        await close(client);
        const state = await fileState(client);
        const current = state.queue.reduce((sum, b) => sum + b.bytes, 0);
        bytes += current;
        maxBytes = Math.max(maxBytes, current);
        maxBatches = Math.max(maxBatches, state.queue.length);
        assert(current <= 64 * 1024 * 1024);
        assert(state.queue.length <= 2048);
        await restart(client);
        assert.equal(
          client.delivery.status().omitted,
          0,
          JSON.stringify({ day, client: client.index, status: client.delivery.status() }),
        );
      }
      // Restart itself creates a genuine new session and recovery evidence.
      // Include its transmission in the day's work before judging drain, rather
      // than asserting that a just-restarted producer generated no new records.
      if (accepting) await drain(clients, 60);
      const restartSnapshot = { bytes, maxBytes, maxBatches };
      bytes = clients.reduce((sum, client) => sum + client.delivery.status().queuedBytes, 0);
      maxBytes = Math.max(...clients.map((client) => client.delivery.status().queuedBytes));
      maxBatches = Math.max(...clients.map((client) => client.delivery.status().queuedBatches));
      const remaining = pending(clients);
      days.push({
        day,
        receiver: accepting ? 'accepting' : 'temporary outage',
        queued: remaining,
        queuedBytes: bytes,
        maxClientBytes: maxBytes,
        maxClientBatches: maxBatches,
        beforeRestart: restartSnapshot,
        cost: subtract(await metrics(), before),
        restartPreservedAllUnacknowledgedWireSha: true,
      });
      consecutiveDrainedDays = accepting && remaining === 0 ? consecutiveDrainedDays + 1 : 0;
      console.error(JSON.stringify({ productionOutboxDay: days.at(-1) }));
    }
    assert.equal(
      consecutiveDrainedDays,
      2,
      'continued normal use did not reach two fully drained days',
    );
    assert(
      [...expected].every((key) => received.has(key)),
      'a producer fixture remains unacknowledged',
    );
    const maxRate = {
      enroll: Math.max(...[...minuteRequests.values()].map((x) => x.enroll)),
      other: Math.max(...[...minuteRequests.values()].map((x) => x.other)),
    };
    assert(maxRate.enroll <= 120);
    assert(maxRate.other <= 300);
    const sessionCardinality = await db.prepare('SELECT COUNT(*) count FROM sessions').first();
    const measuredSessionsPerDay = Math.ceil(sessionCardinality.count / days.length);
    // Measure an actual complete withdrawal while this identity still owns
    // bodies and indexes, rather than reusing a previous revision's cost.
    const withdrawalClient = clients[0];
    const withdrawalState = await fileState(withdrawalClient);
    const installation = withdrawalState.credentials.installationId;
    const ownedBodies = await db
      .prepare('SELECT COUNT(*) count FROM batches WHERE installation_id=?')
      .bind(installation)
      .first();
    assert(ownedBodies.count > 0, 'withdrawal must exercise actual retained bodies');
    const beforeWithdrawal = await metrics();
    await withdrawalClient.delivery.consent(false);
    let withdrawalRequests = 0;
    for (let page = 0; page <= Math.ceil(ownedBodies.count / 99); page++) {
      if (!withdrawalClient.delivery.status().deletionPending) break;
      now = Math.ceil(Math.max(now, withdrawalClient.delivery.status().nextAttemptAt));
      await control();
      await withdrawalClient.delivery.tick(false);
      withdrawalRequests++;
    }
    assert.equal(withdrawalClient.delivery.status().deletionPending, 0);
    const afterWithdrawal = await db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM batches WHERE installation_id=?) bodies,(SELECT COUNT(*) FROM sessions WHERE installation_id=?) sessions',
      )
      .bind(installation, installation)
      .first();
    assert.deepEqual(afterWithdrawal, { bodies: 0, sessions: 0 });
    const withdrawalCost = subtract(await metrics(), beforeWithdrawal);
    const beforeCleanup = await metrics();
    const expiry = epoch + 181 * dayMs;
    const totalPermits = await db.prepare('SELECT COUNT(*) count FROM upload_permits').first();
    for (let page = 0; page < Math.ceil(totalPermits.count / 100) + 10; page++) {
      const response = await fetch(endpoint + '/__test/cleanup?now=' + expiry, { method: 'POST' });
      assert.equal(response.status, 200);
      await response.json();
    }
    const remaining = await db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM installations) installations,(SELECT COUNT(*) FROM sessions) sessions,(SELECT COUNT(*) FROM batches) batches,(SELECT COUNT(*) FROM upload_permits) permits',
      )
      .first();
    assert.deepEqual(remaining, { installations: 0, sessions: 0, batches: 0, permits: 0 });
    const cleanupCost = subtract(await metrics(), beforeCleanup);
    const allocation = steadyAllocation(
      await readFile(
        new URL('../../apps/diagnostics-worker/migrations/0001_diagnostics.sql', import.meta.url),
        'utf8',
      ),
      root,
      {
        sessionsPerDay: measuredSessionsPerDay,
        meanCompressedBytes: Math.round(modeledBytesPerUserDay / normalModel.length),
        metadata: JSON.stringify(normalModel[0].index),
      },
    );
    // Include normal daily restart/session/health traffic observed after full
    // recovery. The initial cohort alone can understate recurring overhead.
    // The first drained day may still include old backlog: it belongs to the
    // recovery peak. A steady day must also START with the previous day empty.
    const steadyDays = days.filter(
      (day, index) => day.receiver === 'accepting' && days[index - 1]?.queued === 0,
    );
    assert(steadyDays.length > 0, 'no full normal day starting without backlog');
    const steadyIngestCost = Object.fromEntries(
      Object.keys(healthyCost).map((key) => [
        key,
        Math.max(healthyCost[key], ...steadyDays.map((day) => day.cost[key])),
      ]),
    );
    const steadyDailyCost = {
      rowsRead:
        steadyIngestCost.rowsRead +
        Math.ceil((cleanupCost.rowsRead + withdrawalCost.rowsRead) / days.length) +
        withdrawalCost.rowsRead,
      rowsWritten:
        steadyIngestCost.rowsWritten +
        Math.ceil((cleanupCost.rowsWritten + withdrawalCost.rowsWritten) / days.length) +
        withdrawalCost.rowsWritten,
      scope:
        'maximum measured 100-user initial day or accepting days starting and ending without backlog, including daily restart, plus complete cohort cleanup amortized daily and one extra actual multi-day installation withdrawal; excludes other apps and unknown writers',
    };
    const peakRecoveryDailyCost = {
      rowsRead:
        Math.max(...days.map((day) => day.cost.rowsRead)) +
        Math.ceil((cleanupCost.rowsRead + withdrawalCost.rowsRead) / days.length) +
        withdrawalCost.rowsRead,
      rowsWritten:
        Math.max(...days.map((day) => day.cost.rowsWritten)) +
        Math.ceil((cleanupCost.rowsWritten + withdrawalCost.rowsWritten) / days.length) +
        withdrawalCost.rowsWritten,
      scope:
        'highest actual recovery day plus measured steady maintenance and one additional complete multi-day installation withdrawal',
    };
    assert(
      steadyDailyCost.rowsWritten < 80000,
      'reserve at least twenty percent of D1 Free writes for the measured 100-user steady day',
    );
    assert(steadyDailyCost.rowsRead < 4000000);
    assert(peakRecoveryDailyCost.rowsRead < 5000000);
    assert(peakRecoveryDailyCost.rowsWritten < 100000);
    const perUser = { compressedBytes: modeledBytesPerUserDay, batches: normalModel.length };
    return {
      schema: 'mizar-production-outbox-multiday/1',
      steadyAllocation: allocation,
      steadyDailyCost,
      peakRecoveryDailyCost,
      scope:
        'actual producer-derived fixtures restored into 100 production on-disk outboxes, then actual initialize/permit/seal/HTTP/ACK/backoff/restart with real local R2 and SQLite; accelerated clock and native limiter bypass only in storage meter, audited logical request cadence and independently tested native shared-IP limiter; not 100 actual games or remote CPU',
      checkpoints,
      days,
      snapshots,
      maxLogicalMinuteRequests: maxRate,
      limits: {
        dailyBytes: 1073741824,
        dailyBatches: 4800,
        installationDailyBytes: 16777216,
        outboxBytes: 64 * 1024 * 1024,
        outboxBatches: 2048,
      },
      perUserDay: perUser,
      verifiedSustainableUsers: 100,
      normalDayHeadroom: {
        bytes: 1 - (modeledBytesPerUserDay * 100) / 1073741824,
        batches: 1 - (normalModel.length * 100) / 4800,
      },
      modeledUserCeilingBeforeReserve: Math.floor(
        Math.min(1073741824 / modeledBytesPerUserDay, 4800 / normalModel.length),
      ),
      allModeledPayloadsAcknowledged: expected.size,
      unacknowledged: 0,
      healthyCost,
      steadyIngestCost,
      steadySourceDays: [0, ...steadyDays.map((day) => day.day)],
      measuredSessionsPerDay,
      bodyAudits: auditedSessions.size,
      withdrawal: {
        cost: withdrawalCost,
        originalBodies: ownedBodies.count,
        requests: withdrawalRequests,
        remaining: afterWithdrawal,
        complete: true,
      },
      cleanup: { cost: cleanupCost, remaining },
      externalAccountRequests: 0,
    };
  } finally {
    for (const client of clients) await close(client);
    await mf.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function steadyAllocation(schema, directory, model) {
  // Physical SQLite allocation of the exact schema, not a remote D1 billing claim.
  // Fixed-budget permits/body locators and measured daily session cardinality.
  const database = new DatabaseSync(join(directory, 'steady-allocation.sqlite'));
  try {
    database.exec(schema);
    const permits = 4800 * 90;
    const bodies = 4800 * 7;
    const sessions = model.sessionsPerDay * 90;
    const owners = 200 * 180; // Maximum configured new identities over a full index horizon.
    const permit = database.prepare('INSERT INTO upload_permits VALUES(?,?,?,?,?,?,?,?)');
    const installation = database.prepare(
      'INSERT INTO installations(id,proof_sha256,created_at,lease_expires_at) VALUES(?,?,?,?)',
    );
    const body = database.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const session = database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const ownerBytes = Buffer.alloc(16, 1);
    database.exec('BEGIN');
    for (let i = 0; i < owners; i++)
      installation.run('public-owner-' + i, 'a'.repeat(64), i, 90 * 86400_000 + i);
    for (let i = 0; i < permits; i++) {
      const digest = Buffer.alloc(32);
      digest.writeUInt32LE(i);
      permit.run(
        digest,
        ownerBytes,
        1,
        'technical-diagnostics-v3',
        1,
        1,
        90 * 86400_000,
        Buffer.alloc(32, 2),
      );
    }
    for (let i = 0; i < bodies; i++)
      body.run(
        'public-owner-' + (i % owners),
        String(i).padStart(64, '0'),
        'v1/' + String(i).padStart(64, '0') + '.gz',
        'public-writer',
        'ready',
        0,
        0,
        model.meanCompressedBytes,
        1,
        7 * 86400_000,
        model.metadata,
      );
    for (let i = 0; i < sessions; i++)
      session.run(
        'public-owner-' + (i % owners),
        String(i).padStart(36, '0'),
        1,
        1,
        '2026-10-17T00:00:00.000Z',
        '2026-10-17T02:00:00.000Z',
        '1.4.0',
        100,
        1,
        '["operation_failed"]',
        0,
        16,
        2000000,
        90 * 86400_000,
      );
    database.exec('COMMIT');
    const allocatedBytes =
      Number(database.prepare('PRAGMA page_count').get().page_count) *
      Number(database.prepare('PRAGMA page_size').get().page_size);
    return {
      scope:
        'actual local SQLite allocation of exact migration; 4800/day permits and body locators, measured session cardinality, maximum configured owner registration horizon; modeled row contents, not account allocation, cloud CPU or billing',
      permits,
      bodies,
      sessions,
      owners,
      allocatedBytes,
      withinProposed400MB: allocatedBytes < 400000000,
    };
  } finally {
    database.close();
  }
}

async function sharedIp(directory, policies) {
  const results = [];
  for (const policy of policies)
    for (const users of [10, 30, 100]) {
      const root = await mkdtemp(join(directory, 'shared-ip-'));
      const mf = runtime(join(root, 'server'), policy.upload, policy.enroll);
      const endpoint = (await mf.ready).origin;
      const db = await mf.getD1Database('DIAGNOSTICS_DB');
      await migrate(db);
      const requests = { enroll: 0, permit: 0, put: 0, statuses: {} };
      const clients = [];
      let loseAck = true;
      const now = Date.now();
      const fetcher = async (input, init) => {
        const path = new URL(input).pathname;
        if (path.endsWith('/enroll')) requests.enroll++;
        else if (path.includes('/permits/')) requests.permit++;
        else if (init.method === 'PUT') requests.put++;
        const headers = new Headers(init.headers);
        headers.set('cf-connecting-ip', '192.0.2.7');
        const response = await fetch(input, { ...init, headers });
        requests.statuses[response.status] = (requests.statuses[response.status] ?? 0) + 1;
        if (loseAck && init.method === 'PUT' && response.ok) {
          loseAck = false;
          await response.arrayBuffer();
          throw new Error('public shared-IP lost ACK');
        }
        return response;
      };
      try {
        for (let i = 0; i < users; i++) {
          const path = join(root, 'client-' + i);
          const journal = new SessionJournal(path, { appVersion: '1.4.0' });
          const delivery = await new DiagnosticDelivery(path, journal, {
            endpoint,
            allowTestEndpoint: true,
            fetch: fetcher,
            now: () => now,
          }).initialize(false);
          await delivery.consent(true);
          journal.record('workspace_exit_begin', {
            installation: i,
            before: { workspace: 'active' },
          });
          journal.record('request_error', {
            installation: i,
            route: '/operator/music',
            method: 'POST',
            error: new Error('public original fault', {
              cause: Object.assign(new Error('public ENOSPC cause'), { code: 'ENOSPC' }),
            }),
          });
          await journal.flush();
          clients.push({ path, journal, delivery });
        }
        await Promise.all(clients.map((c) => c.delivery.tick()));
        const before = clients.map((c) => c.delivery.status());
        const originalIds = await Promise.all(
          clients.map(async (c) =>
            JSON.parse(
              await readFile(join(c.path, 'diagnostic-outbox/state.json'), 'utf8'),
            ).queue.map((b) => b.id),
          ),
        );
        const warm = { accepted: 0, limited: 0 };
        let bearer;
        for (const c of clients) {
          const state = JSON.parse(
            await readFile(join(c.path, 'diagnostic-outbox/state.json'), 'utf8'),
          );
          if (state.credentials?.token) {
            bearer = state.credentials.token;
            break;
          }
        }
        assert(bearer);
        const warmCreatedAt = Math.floor(Date.now() / 1000) * 1000;
        for (let i = 0; i < 400; i++) {
          const response = await fetch(endpoint + '/v1/diagnostics/permits/' + 'f'.repeat(64), {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + bearer,
              'cf-connecting-ip': '192.0.2.7',
              'x-diagnostics-created-at': String(warmCreatedAt),
            },
          });
          await response.arrayBuffer();
          if (response.status === 200) warm.accepted++;
          else if (response.status === 429) warm.limited++;
          else throw new Error('unexpected warm limiter status ' + response.status);
        }
        assert(warm.limited > 0);
        const acknowledged = before.reduce((n, s) => n + s.acknowledged, 0);
        const queued = before.reduce((n, s) => n + s.queuedBatches, 0);
        assert.equal(acknowledged, Math.min(users, policy.enroll) - 1);
        if (users > policy.enroll) assert(requests.statuses[429] > 0);
        else assert.equal(requests.statuses[429] ?? 0, 0);
        assert.equal(acknowledged + queued, users);
        await Promise.all(
          clients.map(async (c) => {
            await c.delivery.close();
            await c.journal.close();
          }),
        );
        let recovered = 0;
        let clientIndex = 0;
        for (const c of clients) {
          const journal = new SessionJournal(c.path);
          const delivery = await new DiagnosticDelivery(c.path, journal, {
            endpoint,
            allowTestEndpoint: true,
            fetch: fetcher,
            now: () => now,
          }).initialize(false);
          recovered += delivery.status().queuedBatches;
          const restored = JSON.parse(
            await readFile(join(c.path, 'diagnostic-outbox/state.json'), 'utf8'),
          ).queue.map((b) => b.id);
          assert(originalIds[clientIndex++].every((id) => restored.includes(id)));
          await delivery.close();
          await journal.close();
        }
        assert(recovered >= queued);
        const dimensions = await db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM installations) installations,(SELECT COUNT(*) FROM batches WHERE state='ready') ready",
          )
          .first();
        const result = {
          policy,
          users,
          requests,
          warm400PermitRequests: warm,
          allOriginalUnacknowledgedIdsPreserved: true,
          acknowledged,
          queuedBeforeRestart: queued,
          queuedAfterRestart: recovered,
          restartAddsNewSessionAndHealthEvidence: true,
          dimensions,
          networkDrainClaimed: false,
          scope:
            'actual local workerd native limiter with the reported configured policy on one identical public test IP; all clients use actual on-disk journal/outbox and restart; accelerated no simulated limiter clock',
        };
        results.push(result);
        console.error(JSON.stringify(result));
      } finally {
        await Promise.all(
          clients.map(async (c) => {
            await c.delivery.close();
            await c.journal.close();
          }),
        );
        await mf.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }
  return { schema: 'mizar-shared-ip-capacity/1', results, externalAccountRequests: 0 };
}

async function fault(directory) {
  const root = await mkdtemp(join(directory, 'fault-'));
  const journal = new SessionJournal(root, { appVersion: '1.4.0' });
  let now = Date.now();
  const epoch = now;
  const delivery = await new DiagnosticDelivery(root, journal, {
    endpoint: 'https://capacity.invalid',
    now: () => now,
  }).initialize(false);
  await delivery.consent(true);
  await delivery.pause(true);
  const started = performance.now();
  try {
    for (let i = 0; i < 6000; i++) {
      now += 10;
      journal.record('request_error', {
        requestId: 'public-fault-' + i,
        taskId: 'public-root',
        route: '/operator/music',
        method: 'POST',
        reason: 'music_file_write_failed',
        before: { enabled: false },
        after: { enabled: false },
        error: new Error('Cannot save configuration token=PRIVATE-FAULT', {
          cause: Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
            syscall: 'write',
          }),
        }),
      });
      if (i % 64 === 63) await journal.flush();
    }
    await journal.flush();
    await delivery.close();
    await journal.close();
    const state = JSON.parse(await readFile(join(root, 'diagnostic-outbox/state.json'), 'utf8'));
    const packets = [];
    let errors = 0,
      expanded = 0,
      gzip = 0;
    for (const b of state.queue) {
      const body = await readFile(join(root, 'diagnostic-outbox', b.id + '.gz'));
      const decoded = await decodeDiagnosticBatch(body);
      packets.push({ index: b.index, bytes: body.toString('base64') });
      const text = JSON.stringify(decoded);
      assert(!text.includes('PRIVATE-FAULT'));
      expanded += Buffer.byteLength(text);
      gzip += body.length;
      for (const e of decoded.events)
        if (e.stage === 'request_error') {
          assert.equal(e.evidence.error.cause.code, 'ENOSPC');
          errors++;
        }
    }
    assert.equal(errors, 6000);
    assert.equal(delivery.status().omitted, 0);
    const output = {
      schema: 'mizar-final-fault/1',
      epoch,
      scope:
        '6000 modeled faults per virtual minute through actual journal/outbox, async disk catch-up every64 records; queued paused, no external network; elapsed drain ticks are not field minutes',
      faults: errors,
      expanded,
      gzip,
      batches: state.queue.length,
      journal: journal.health(),
      outbox: delivery.status(),
      wallMs: performance.now() - started,
    };
    return { report: output, packets };
  } finally {
    await delivery.close();
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

const repository = fileURLToPath(new URL('../..', import.meta.url));
const sourceFiles = [
  'apps/companion/src/app.ts',
  'apps/companion/src/support/delivery.ts',
  'apps/companion/src/support/session-journal.ts',
  'apps/companion/src/support/native-source.ts',
  'apps/companion/src/support/performance-window.ts',
  'apps/companion/src/support/performance-spool.ts',
  'apps/diagnostics-worker/src/index.ts',
  'apps/diagnostics-worker/wrangler.jsonc',
  'apps/diagnostics-worker/migrations/0001_diagnostics.sql',
  'packages/protocol/src/diagnostics-upload.ts',
  'scripts/diagnostics/measure-capacity.mjs',
  'scripts/diagnostics/capacity-runtime.mjs',
  'scripts/diagnostics/outbox-capacity.mjs',
  'scripts/diagnostics/fixtures/capacity-producers.json',
  'tests/diagnostics/fixture.ts',
];
const sourceIdentity = {
  head:
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  workingTreeClean:
    execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim() ===
    '',
  filesSha256: Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(repository, path)))
          .digest('hex'),
      ]),
    ),
  ),
};
const directory = await mkdtemp(join(tmpdir(), 'mizar-integrated-capacity-'));
try {
  const configuration = JSON.parse(
    await readFile(
      new URL('../../apps/diagnostics-worker/wrangler.jsonc', import.meta.url),
      'utf8',
    ),
  );
  const configured = {
    name: 'configured',
    enroll: configuration.ratelimits.find((v) => v.name === 'ENROLL_LIMITER').simple.limit,
    upload: configuration.ratelimits.find((v) => v.name === 'UPLOAD_LIMITER').simple.limit,
  };
  const result = await profile(directory);
  console.error(JSON.stringify({ profile: result.report }));
  const faultResult = await fault(directory);
  const sharedResult = await sharedIp(directory, [
    { name: 'previous', enroll: 5, upload: 30 },
    configured,
  ]);
  const cloudResult = await cloud(directory, result, faultResult);
  const outboxBounds = await fullOutbox(directory);
  const report = {
    schema: 'mizar-integrated-capacity/1',
    sourceIdentity,
    scope:
      'Public synthetic frequency model through actual collectors, durable queue, real local R2/SQLite D1; no external account requests, cloud CPU or actual game claims',
    profile: result.report,
    fault: faultResult.report,
    sharedIp: sharedResult,
    cloud: cloudResult,
    outboxBounds,
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await rm(directory, { recursive: true, force: true });
}
