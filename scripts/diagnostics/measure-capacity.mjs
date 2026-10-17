import { DatabaseSync } from 'node:sqlite';
import { meteredRuntime } from './capacity-runtime.mjs';
/** Reproducible public synthetic qualification; never connects to a Cloudflare account. */
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { strict as assert } from 'node:assert';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { buildApp } from '../../apps/companion/src/app.ts';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.ts';
import {
  DiagnosticDelivery,
  decodeDiagnosticBatch,
} from '../../apps/companion/src/support/delivery.ts';
import { runtime, migrate, bindings } from '../../tests/diagnostics/fixture.ts';
import {
  sealDiagnosticGzip,
  stampDiagnosticGzip,
  diagnosticGzipCreatedAt,
  diagnosticInstallationId,
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
  await app.ready();
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
      rates: {
        gsiHz: 20,
        players: 16,
        inputVariation:
          'changing positions, health, publication counters and technical line counters',
        ownReadsPerMinute: 120,
        browserAggregatesPerMinute: 8,
        nativeOperationsPerMinute: 3,
        technicalConsoleLinesPerSecond: 1,
        browserFaultsPerTenMinutes: 1,
        runtimeAggregatesPerMinute: 4,
      },
      frames,
      http,
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

async function cloud(directory, profileResult, faultResult) {
  const root = await mkdtemp(join(directory, 'cloud-'));
  const mf = meteredRuntime(root);
  const endpoint = (await mf.ready).origin;
  const db = await mf.getD1Database('DIAGNOSTICS_DB');
  await migrate(db);
  const call = (path, init) =>
    fetch(endpoint + path, {
      ...init,
      headers: { 'cf-connecting-ip': '127.0.0.1', ...init.headers },
    });
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const snapshot = async () => (await fetch(endpoint + '/__test/metrics')).json();
  const counts = await snapshot();
  const difference = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));
  const source = profileResult.packets;
  const profile = profileResult.report;
  const totalBatchesPerInstallation = source.length * 3 + faultResult.packets.length;
  const users = [];
  const checkpoints = [];
  const starts = performance.now();
  const retainedDirectory = join(root, 'retained-refusals');
  await mkdir(retainedDirectory);
  const refusals = [];
  let acceptedBatches = 0,
    acceptedSessions = 0,
    auditedSessions = 0;
  const expiryNow = Date.now() + 181 * 86400_000;
  try {
    const registrationTotals = Object.fromEntries(Object.keys(counts).map((k) => [k, 0]));
    for (let group = 0; group < 10; group++) {
      const current = [];
      for (let offset = 0; offset < 10; offset++) {
        const installation = diagnosticInstallationId(Date.now(), randomBytes(16));
        const before = await snapshot();
        const enroll = await call('/v1/diagnostics/enroll', {
          method: 'POST',
          body: JSON.stringify({
            consent: 'technical-diagnostics-v3',
            enrollmentId: installation,
            enrollmentSecret: hash('public-secret-' + installation),
          }),
        });
        assert.equal(enroll.status, 200);
        const identity = await enroll.json();
        const cost = difference(await snapshot(), before);
        for (const key of Object.keys(cost)) registrationTotals[key] += cost[key];
        current.push({ installation, identity });
      }
      await Promise.all(
        current.map(async ({ installation, identity }) => {
          let expanded = 0,
            compressed = 0;
          for (let dailySession = 0; dailySession < 4; dailySession++) {
            const currentSource = dailySession === 3 ? faultResult.packets : source;
            const session = randomUUID();
            let first;
            for (let i = 0; i < currentSource.length; i++) {
              const original = JSON.parse(
                gunzipSync(Buffer.from(currentSource[i].bytes, 'base64')).toString(),
              );
              const oldSession = original.events[0].startupSessionId;
              const plain = Buffer.from(JSON.stringify(original).replaceAll(oldSession, session));
              const raw = Buffer.from(stampDiagnosticGzip(gzipSync(plain), Date.now()));
              const issue = await call('/v1/diagnostics/permits/' + hash(raw), {
                method: 'POST',
                headers: {
                  authorization: 'Bearer ' + identity.token,
                  'x-diagnostics-created-at': String(diagnosticGzipCreatedAt(raw)),
                },
              });
              if (issue.status === 429) {
                const reason = await issue.json();
                assert.equal(reason.error, 'permit_budget');
                const id = hash(raw);
                await writeFile(join(retainedDirectory, id + '.gz'), raw);
                refusals.push({
                  id,
                  installation,
                  session,
                  bytes: raw.length,
                  expandedBytes: plain.length,
                  reason: reason.error,
                });
                continue;
              }
              assert.equal(issue.status, 200);
              const permit = await issue.json();
              const bytes = Buffer.from(sealDiagnosticGzip(raw, permit));
              const id = hash(bytes);
              const index = {
                ...currentSource[i].index,
                sessionId: session,
                expandedBytes: plain.length,
              };
              const init = {
                method: 'PUT',
                headers: {
                  authorization: 'Bearer ' + identity.token,
                  'content-type': 'application/gzip',
                  'x-content-sha256': id,
                  'x-diagnostics-index': JSON.stringify(index),
                },
                body: bytes,
              };
              const accepted = await call('/v1/diagnostics/batches/' + id, init);
              assert.equal(accepted.status, 200);
              assert.equal((await accepted.json()).batchId, id);
              acceptedBatches++;
              first ??= { id, init };
              expanded += plain.length;
              compressed += bytes.length;
            }
            if (!first) continue;
            acceptedSessions++;
            const beforeReplay = await db
              .prepare(
                'SELECT object_key,received_at,expires_at FROM batches WHERE installation_id=? AND id=?',
              )
              .bind(installation, first.id)
              .first();
            const replay = await call('/v1/diagnostics/batches/' + first.id, first.init);
            assert.equal(replay.status, 200);
            assert.deepEqual(await replay.json(), {
              accepted: true,
              batchId: first.id,
              sha256: first.id,
            });
            const afterReplay = await db
              .prepare(
                'SELECT object_key,received_at,expires_at FROM batches WHERE installation_id=? AND id=?',
              )
              .bind(installation, first.id)
              .first();
            assert.deepEqual(afterReplay, beforeReplay);
            const downloaded = await call('/admin/bodies/' + installation + '/' + first.id, {
              method: 'GET',
              headers: { authorization: 'Bearer ' + bindings.ADMIN_KEY },
            });
            assert.equal(downloaded.status, 200);
            const body = Buffer.from(await downloaded.arrayBuffer());
            assert.equal(hash(body), first.id);
            assert((await decodeDiagnosticBatch(body)).events.length > 0);
            auditedSessions++;
          }
          users.push({ installation, expanded, compressed });
        }),
      );
      const userCount = (group + 1) * 10;
      if ([10, 30, 100].includes(userCount)) {
        const dimensions = await db
          .prepare(
            'SELECT (SELECT COUNT(*) FROM installations) installations,(SELECT COUNT(*) FROM sessions) sessions,(SELECT COUNT(*) FROM batches) batches,(SELECT COUNT(*) FROM upload_permits) permits',
          )
          .first();
        const isolation = await db
          .prepare(
            'SELECT COUNT(*) count FROM sessions s LEFT JOIN installations i ON i.id=s.installation_id WHERE i.id IS NULL',
          )
          .first();
        assert.equal(isolation.count, 0);
        assert.equal(dimensions.sessions, acceptedSessions);
        assert.equal(dimensions.batches, acceptedBatches);
        assert.equal(acceptedBatches + refusals.length, userCount * totalBatchesPerInstallation);
        checkpoints.push({
          users: userCount,
          hoursPerUser: 6,
          sessionsPerUser: 4,
          faultBurstsPerUser: 1,
          actualDimensions: dimensions,
          offeredBatches: userCount * totalBatchesPerInstallation,
          refusedRetainedBatches: refusals.length,
          cloudComplete: refusals.length === 0,
          total: await snapshot(),
          isolationVerified: true,
        });
        console.error(JSON.stringify(checkpoints.at(-1)));
      }
    }
    const uploadTotals = await snapshot();
    const perUser = Object.fromEntries(
      Object.keys(counts).map((k) => [k, (uploadTotals[k] - registrationTotals[k]) / 100]),
    );
    const registrationAndIndexTotal = await snapshot();
    const beforeCleanup = await snapshot();
    let cleaned = 0;
    for (let page = 0; page < Math.ceil(totalBatchesPerInstallation) + 1; page++) {
      const response = await fetch(
        endpoint + '/__test/cleanup?now=' + (Date.now() + 8 * 86400000),
        { method: 'POST' },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { done: true });
      cleaned++;
    }
    const cleanupCost = difference(await snapshot(), beforeCleanup);
    const remaining = await db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM batches) batches,(SELECT COUNT(*) FROM sessions) sessions,(SELECT COUNT(*) FROM upload_permits) permits',
      )
      .first();
    assert.equal(remaining.batches, 0);
    assert.equal(remaining.sessions, acceptedSessions);
    assert.equal(remaining.permits, acceptedBatches);
    // Reopen exact refused bytes rather than dropping a saturated model input.
    await writeFile(join(retainedDirectory, 'manifest.json'), JSON.stringify(refusals));
    const recovered = JSON.parse(await readFile(join(retainedDirectory, 'manifest.json'), 'utf8'));
    for (const item of recovered) {
      const raw = await readFile(join(retainedDirectory, item.id + '.gz'));
      assert.equal(hash(raw), item.id);
      assert.equal(gunzipSync(raw).length, item.expandedBytes);
    }
    const beforeFiniteCleanup = await snapshot();
    let finitePages = 0;
    for (
      let page = 0;
      page < Math.ceil(Math.max(acceptedBatches, acceptedSessions) / 100) + 2;
      page++
    ) {
      const response = await fetch(endpoint + '/__test/cleanup?now=' + expiryNow, {
        method: 'POST',
      });
      assert.equal(response.status, 200);
      await response.json();
      finitePages++;
    }
    const finiteCleanupCost = difference(await snapshot(), beforeFiniteCleanup);
    const finalRows = await db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM installations) installations,(SELECT COUNT(*) FROM sessions) sessions,(SELECT COUNT(*) FROM batches) batches,(SELECT COUNT(*) FROM upload_permits) permits',
      )
      .first();
    assert.deepEqual(finalRows, { installations: 0, sessions: 0, batches: 0, permits: 0 });
    // Meter the destructive path separately while a real body and index exist.
    // This is an isolated public installation, not a reused/expired cohort owner.
    const maintenanceOwner = diagnosticInstallationId(Date.now(), randomBytes(16));
    const enrolled = await call('/v1/diagnostics/enroll', {
      method: 'POST',
      body: JSON.stringify({
        consent: 'technical-diagnostics-v3',
        enrollmentId: maintenanceOwner,
        enrollmentSecret: hash('public-maintenance-proof'),
      }),
    });
    assert.equal(enrolled.status, 200);
    const maintenanceIdentity = await enrolled.json();
    const maintenanceRaw = Buffer.from(
      stampDiagnosticGzip(
        gzipSync(
          JSON.stringify({
            schema: 'mizar-technical-diagnostics/1',
            events: [
              { stage: 'normal_operation', evidence: { result: 'public cleanup evidence' } },
            ],
          }),
        ),
        Date.now(),
      ),
    );
    const issued = await call('/v1/diagnostics/permits/' + hash(maintenanceRaw), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + maintenanceIdentity.token,
        'x-diagnostics-created-at': String(diagnosticGzipCreatedAt(maintenanceRaw)),
      },
    });
    assert.equal(issued.status, 200);
    const maintenanceWire = Buffer.from(sealDiagnosticGzip(maintenanceRaw, await issued.json()));
    const maintenanceId = hash(maintenanceWire);
    const maintenanceUpload = await call('/v1/diagnostics/batches/' + maintenanceId, {
      method: 'PUT',
      body: maintenanceWire,
      headers: {
        authorization: 'Bearer ' + maintenanceIdentity.token,
        'content-type': 'application/gzip',
        'x-content-sha256': maintenanceId,
        'x-diagnostics-index': JSON.stringify({
          schema: 'mizar-technical-diagnostics/1',
          events: 1,
          expandedBytes: 256,
          stages: ['normal_operation'],
          sessionId: randomUUID(),
        }),
      },
    });
    assert.equal(maintenanceUpload.status, 200);
    await maintenanceUpload.json();
    const beforeWithdrawal = await snapshot();
    const withdrawn = await call('/v1/diagnostics/installation', {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + maintenanceIdentity.token },
    });
    assert.equal(withdrawn.status, 200);
    assert.deepEqual(await withdrawn.json(), {
      installationId: maintenanceOwner,
      revoked: true,
      deletion: 'complete',
    });
    const withdrawalCost = difference(await snapshot(), beforeWithdrawal);
    const afterWithdrawal = await db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM batches) bodies,(SELECT COUNT(*) FROM sessions) sessions',
      )
      .first();
    assert.deepEqual(afterWithdrawal, { bodies: 0, sessions: 0 });
    const maintenanceCleanup = await fetch(endpoint + '/__test/cleanup?now=' + expiryNow, {
      method: 'POST',
    });
    assert.equal(maintenanceCleanup.status, 200);
    await maintenanceCleanup.json();
    const health = await call('/admin/health', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + bindings.ADMIN_KEY },
    });
    const healthBody = await health.json();
    const allocation = steadyAllocation(
      await readFile(
        new URL('../../apps/diagnostics-worker/migrations/0001_diagnostics.sql', import.meta.url),
        'utf8',
      ),
      root,
      {
        sessionsPerDay: acceptedSessions,
        meanCompressedBytes: Math.round(
          users.reduce((n, x) => n + x.compressed, 0) / acceptedBatches,
        ),
        metadata: JSON.stringify(source[0].index),
      },
    );
    const output = {
      schema: 'mizar-final-cloud-capacity/1',
      steadyAllocation: allocation,
      withdrawal: { cost: withdrawalCost, remaining: afterWithdrawal, actualCompleteAck: true },
      steadyDailyCost: {
        scope:
          'one complete measured cohort lifecycle amortized per day at steady retention, plus a conservative additional 100 measured one-body withdrawals; not account totals or other apps',
        rowsRead:
          uploadTotals.rowsRead +
          cleanupCost.rowsRead +
          finiteCleanupCost.rowsRead +
          100 * withdrawalCost.rowsRead,
        rowsWritten:
          uploadTotals.rowsWritten +
          cleanupCost.rowsWritten +
          finiteCleanupCost.rowsWritten +
          100 * withdrawalCost.rowsWritten,
      },
      scope:
        'production handler over real HTTP with native local workerd R2 and SQLite D1 metered row metadata; rate limiter bypassed only for accelerated 100-user storage replay, separately tested actual shared-IP limiter; ten concurrent HTTP clients per group, three daily two-hour normal sessions plus one 6000-error burst per installation and one private body audit per session; one actual collector profile cloned with distinct installation/session identities, not 100 real CS2 computers, not deployed cloud CPU/request throughput',
      profile: {
        minutes: profile.minutes,
        events: profile.events,
        batches: source.length,
        expanded: profile.expanded,
        gzipBytes: profile.gzipBytes,
      },
      checkpoints,
      perUserDayIncludingOneBodyAuditPerSession: perUser,
      measuredHoursPerUser: 6,
      measuredSessionsPerUser: 4,
      registrationAndIndexTotal,
      registrationTotals,
      cleanup: { invocations: cleaned, cost: cleanupCost, remaining },
      finiteCleanup: {
        invocations: finitePages,
        cost: finiteCleanupCost,
        remaining: finalRows,
        atDays: 181,
      },
      offeredBatches: 100 * totalBatchesPerInstallation,
      refusalRetention: {
        batches: refusals.length,
        bytes: refusals.reduce((n, x) => n + x.bytes, 0),
        allOriginalShaReopened: true,
        cloudComplete: refusals.length === 0,
        scope:
          'raw payload files and refusal manifest persisted/reopened in isolated measurement directory; production outbox retry/restart separately exercised by sharedIp',
      },
      database: {
        allocatedBytes: healthBody.d1AllocatedBytes,
        allocationIncludesReusedFreePages: true,
      },
      health: healthBody,
      retries: {
        sameIdentityAuditsTotal: auditedSessions,
        retentionClockUnchanged: true,
        noExtraObjectWrites: registrationAndIndexTotal.put === acceptedBatches,
      },
      wallMs: performance.now() - starts,
      externalAccountRequests: 0,
    };
    return output;
  } finally {
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
  const faultResult = await fault(directory);
  const sharedResult = await sharedIp(directory, [
    { name: 'previous', enroll: 5, upload: 30 },
    configured,
  ]);
  const cloudResult = await cloud(directory, result, faultResult);
  const report = {
    schema: 'mizar-integrated-capacity/1',
    sourceIdentity,
    scope:
      'Public synthetic frequency model through actual collectors, durable queue, real local R2/SQLite D1; no external account requests, cloud CPU or actual game claims',
    profile: result.report,
    fault: faultResult.report,
    sharedIp: sharedResult,
    cloud: cloudResult,
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await rm(directory, { recursive: true, force: true });
}
