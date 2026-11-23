import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { runArchiveWorker } from '../src/support/archive-worker.js';
import { diagnosticEvidence, needsEvidenceSanitize } from '../src/support/diagnostic-value.js';
import { SupportExports } from '../src/support/export-job.js';
import { segmentMaxObservedAt } from '../src/support/retention.js';
import { BOX_READ_TOKEN } from '../src/updates/contract.js';

test('needsEvidenceSanitize fast-path matches diagnosticEvidence output on clean and sensitive events', () => {
  const cleanEvent = {
    schema: 'mizar-diagnostic-event/2',
    eventId: '00000000-0000-4000-8000-000000000001',
    kind: 'obs_status_polled',
    stage: 'obs',
    phase: 'active',
    outcome: 'ok',
    observedAt: '2026-11-20T10:00:00.000Z',
    evidence: { connected: true, streaming: true, fps: 60 },
    coverage: { occurrences: 1 },
  };
  const cleanRaw = JSON.stringify(cleanEvent);
  assert.equal(needsEvidenceSanitize(cleanRaw), false);
  assert.deepEqual(diagnosticEvidence(cleanEvent), cleanEvent);

  const sensitiveCases: unknown[] = [
    { ...cleanEvent, evidence: { password: 'secret-value' } },
    { ...cleanEvent, evidence: { ticket: '11111111-1111-4111-8111-111111111111' } },
    { ...cleanEvent, evidence: { url: 'rtmp://live.example.com/app/stream-secret' } },
    { ...cleanEvent, evidence: { auth: 'Bearer rh_mizar_abc123' } },
    { ...cleanEvent, evidence: { box: BOX_READ_TOKEN } },
    { ...cleanEvent, evidence: { nested: '{"token":"abc"}' } },
    { ...cleanEvent, kind: 'program_all_chat', evidence: { text: 'hello' } },
    { ...cleanEvent, evidence: { stream: { key: 'live_key' } } },
    { ...cleanEvent, evidence: { apiKey: 'ak_123' } },
    { ...cleanEvent, evidence: { api_key: 'ak_123' } },
    { ...cleanEvent, evidence: { streamKey: 'sk_123' } },
    { ...cleanEvent, evidence: { stream_key: 'sk_123' } },
    { ...cleanEvent, evidence: { deviceCode: 'dc_123' } },
    { ...cleanEvent, evidence: { device_code: 'dc_123' } },
    { ...cleanEvent, evidence: { userCode: 'uc_123' } },
    { ...cleanEvent, evidence: { user_code: 'uc_123' } },
    { ...cleanEvent, evidence: { pairingCode: 'pc_123' } },
    { ...cleanEvent, evidence: { pairing_code: 'pc_123' } },
    { ...cleanEvent, evidence: { accessToken: 'at_123' } },
    { ...cleanEvent, evidence: { 'proxy-authorization': 'Basic abc' } },
    { ...cleanEvent, evidence: { 'set-cookie': 'sid=abc' } },
  ];
  for (const item of sensitiveCases) {
    const raw = JSON.stringify(item);
    assert.equal(needsEvidenceSanitize(raw), true, `expected sanitize for ${raw}`);
    assert.notDeepEqual(diagnosticEvidence(item), item, `expected redaction for ${raw}`);
  }
  assert.equal(needsEvidenceSanitize('{"\u0074oken":"secret"}'), true);
});

test('runArchiveWorker covers single-file failures, active partial lines, rotated gzip segments, and disk budget', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-archive-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const logsDir = join(dir, 'logs');
  const outDir = join(dir, 'out');
  mkdirSync(logsDir);
  mkdirSync(outDir);

  const goodEvent = {
    schema: 'mizar-diagnostic-event/2',
    eventId: '00000000-0000-4000-8000-000000000010',
    kind: 'session_started',
    observedAt: '2026-11-20T10:00:00.000Z',
    evidence: { ok: true },
  };
  const gzEvent = {
    schema: 'mizar-diagnostic-event/2',
    eventId: '00000000-0000-4000-8000-000000000011',
    kind: 'segment_rotated',
    observedAt: '2026-11-20T09:59:00.000Z',
    evidence: { rotated: true },
  };

  const activePath = join(logsDir, 'active.ndjson');
  writeFileSync(activePath, JSON.stringify(goodEvent) + '\n{"uncommitted_partial":');
  const gzPath = join(logsDir, 'sealed.ndjson.gz');
  writeFileSync(gzPath, gzipSync(Buffer.from(JSON.stringify([gzEvent]))));

  const activeFd = openSync(activePath, 'r');
  const gzFd = openSync(gzPath, 'r');
  t.after(() => {
    closeSync(activeFd);
    closeSync(gzFd);
  });

  runArchiveWorker(
    {
      sources: [
        { name: 'logs/active.ndjson', fd: activeFd, bytes: readFileSync(activePath).length },
        { name: 'logs/broken.ndjson', fd: -1, bytes: 128 },
        { name: 'logs/sealed.ndjson.gz', fd: gzFd, bytes: readFileSync(gzPath).length },
      ],
      gaps: [],
      output: outDir,
      exportId: 'export-1',
      range: {},
      snapshot: { asOf: '2026-11-20T10:00:00.000Z', sources: [], unknown: [] },
    },
    () => undefined,
  );

  const zipEntries = unzipSync(readFileSync(join(outDir, 'part-1.zip')));
  const coverage = JSON.parse(Buffer.from(zipEntries['coverage.json']!).toString('utf8')) as {
    retainedRecords: number;
    gaps: { source: string; reason: string }[];
  };
  assert.equal(coverage.retainedRecords, 2);
  assert.ok(
    coverage.gaps.some(
      (g) => g.source === 'logs/active.ndjson' && g.reason === 'uncommitted_partial_line',
    ),
  );
  assert.ok(coverage.gaps.some((g) => g.source === 'logs/broken.ndjson'));

  const eventsText = Buffer.from(zipEntries['events/1.ndjson']!).toString('utf8');
  const exportedIds = eventsText
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { eventId: string }).eventId);
  assert.deepEqual(exportedIds, [goodEvent.eventId, gzEvent.eventId]);

  // Disk budget exhaustion fails cleanly without leaving part-1.zip
  const budgetDir = join(dir, 'out-budget');
  mkdirSync(budgetDir);
  const activeFd2 = openSync(activePath, 'r');
  t.after(() => closeSync(activeFd2));
  const messages: Record<string, unknown>[] = [];
  runArchiveWorker(
    {
      sources: [
        { name: 'logs/active.ndjson', fd: activeFd2, bytes: readFileSync(activePath).length },
      ],
      gaps: [],
      output: budgetDir,
      exportId: 'export-budget',
      range: {},
      snapshot: { asOf: '2026-11-20T10:00:00.000Z', sources: [], unknown: [] },
      diskBudgetBytes: 64,
    },
    (msg) => messages.push(msg),
  );
  assert.equal(messages.at(-1)?.phase, 'failed');
  assert.match(String(messages.at(-1)?.error), /export_output_failed/);
});

test('SupportExports supports cancellation and retry', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mizar-export-job-')));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const logsDir = join(dir, 'logs');
  mkdirSync(logsDir);
  writeFileSync(
    join(logsDir, 'session-00000000-0000-4000-8000-000000000020.ndjson'),
    JSON.stringify({
      schema: 'mizar-diagnostic-event/2',
      eventId: '00000000-0000-4000-8000-000000000020',
      kind: 'companion_started',
      observedAt: '2026-11-20T10:00:00.000Z',
    }) + '\n',
  );

  const exports = new SupportExports(logsDir);
  const first = await exports.begin({}, null);
  await exports.cancel(first.exportId);
  await exports.whenSettled(first.exportId);

  writeFileSync(
    join(logsDir, 'session-00000000-0000-4000-8000-000000000099.ndjson'),
    JSON.stringify({
      schema: 'mizar-diagnostic-event/2',
      eventId: '00000000-0000-4000-8000-000000000099',
      kind: 'session_started',
      observedAt: '2026-11-15T10:00:00.000Z',
    }) + '\n',
  );
  // Legacy segment without maxObservedAt and out-of-order segment with trailing spanning renewal must both be retained.
  writeFileSync(
    join(logsDir, 'session-00000000-0000-4000-8000-000000000098.ndjson'),
    [
      {
        schema: 'mizar-diagnostic-event/2',
        eventId: '00000000-0000-4000-8000-000000000097',
        kind: 'legacy_out_of_order',
        observedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        schema: 'mizar-diagnostic-event/2',
        eventId: '00000000-0000-4000-8000-000000000098',
        kind: 'session_started',
        observedAt: '2026-11-15T10:00:00.000Z',
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  const spanningEvents = [
    {
      schema: 'mizar-diagnostic-event/2',
      eventId: '00000000-0000-4000-8000-000000000095',
      kind: 'late_event',
      observedAt: '2026-11-22T12:00:00.000Z',
    },
    {
      schema: 'mizar-diagnostic-event/2',
      eventId: '00000000-0000-4000-8000-000000000096',
      kind: 'runtime_renewal',
      observedAt: '2026-11-18T00:00:00.000Z',
      sourceInterval: { from: '2026-11-18T00:00:00.000Z', to: '2026-11-22T11:00:00.000Z' },
    },
  ];
  writeFileSync(
    join(logsDir, 'session-00000000-0000-4000-8000-000000000096.ndjson'),
    spanningEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  assert.equal(segmentMaxObservedAt(spanningEvents), '2026-11-22T12:00:00.000Z');
  writeFileSync(
    join(logsDir, 'retention-companion.json'),
    JSON.stringify({
      segments: [
        {
          name: 'session-00000000-0000-4000-8000-000000000099.ndjson',
          lastObservedAt: '2026-11-15T10:00:00.000Z',
          maxObservedAt: '2026-11-15T10:00:00.000Z',
        },
        {
          name: 'session-00000000-0000-4000-8000-000000000098.ndjson',
          lastObservedAt: '2026-11-15T10:00:00.000Z',
        },
        {
          name: 'session-00000000-0000-4000-8000-000000000096.ndjson',
          lastObservedAt: '2026-11-18T00:00:00.000Z',
          maxObservedAt: segmentMaxObservedAt(spanningEvents),
        },
      ],
    }),
  );

  const retried = await exports.begin({ from: '2026-11-20T00:00:00.000Z' }, null);
  const settled = await exports.whenSettled(retried.exportId);
  assert.equal(settled?.phase, 'ready', `unexpected error: ${settled?.error}`);
  const zip = unzipSync(readFileSync(join(exports.directory, retried.exportId, 'part-1.zip')));
  const coverage = JSON.parse(Buffer.from(zip['coverage.json']!).toString('utf8')) as {
    retainedRecords: number;
    excludedSources: { source: string; reason: string }[];
  };
  assert.equal(coverage.retainedRecords, 4);
  assert.ok(
    coverage.excludedSources.some(
      (entry) => entry.source === 'session-00000000-0000-4000-8000-000000000099.ndjson',
    ),
  );
  assert.ok(
    !coverage.excludedSources.some((entry) =>
      ['0098', '0096'].some((suffix) => entry.source.includes(suffix)),
    ),
  );
});

test('needsEvidenceSanitize never misses JSON-escaped URLs, nested JSON, or unicode keys', () => {
  const escapedSamples = [
    '{"schema":"mizar-diagnostic-event/2","evidence":{"url":"rtmps:\\/\\/live.twitch.tv\\/app\\/live_secret_99"}}',
    '{"schema":"mizar-diagnostic-event/2","evidence":{"url":"https:\\/\\/user:pass@example.com\\/hook?auth=abc"}}',
    '{"schema":"mizar-diagnostic-event/2","evidence":{"stream":{"raw":"\\n  {\\"key\\":\\"stream-secret\\"}"}}}',
    '{"schema":"mizar-diagnostic-event/2","evidence":{"\\u0061piKey":"secret-val"}}',
    '{"schema":"mizar-diagnostic-event/2","evidence":{"ok":true,"count":42,"msg":"normal line"}}',
  ];
  for (const raw of escapedSamples) {
    const parsed = JSON.parse(raw);
    const sanitized = JSON.stringify(diagnosticEvidence(parsed));
    if (!needsEvidenceSanitize(raw)) {
      assert.equal(sanitized, JSON.stringify(parsed), `fast-path missed sanitization for: ${raw}`);
    }
  }
  assert.equal(needsEvidenceSanitize(escapedSamples[0]!), true);
  assert.equal(needsEvidenceSanitize(escapedSamples[1]!), true);
  assert.equal(needsEvidenceSanitize(escapedSamples[2]!), true);
  assert.equal(needsEvidenceSanitize(escapedSamples[3]!), true);
  assert.equal(needsEvidenceSanitize(escapedSamples[4]!), false);
});

test('SupportExports ignores and preserves safe unknown entries inside its cache directory', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mizar-export-unknown-entry-')));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const logsDir = join(dir, 'logs');
  mkdirSync(logsDir);
  writeFileSync(
    join(logsDir, 'companion-20261120.ndjson'),
    JSON.stringify({
      schema: 'mizar-diagnostic-event/2',
      eventId: '00000000-0000-4000-8000-000000000021',
      kind: 'companion_started',
      observedAt: '2026-11-20T10:00:00.000Z',
    }) + '\n',
  );

  const exports = new SupportExports(logsDir);
  mkdirSync(exports.directory, { recursive: true });
  const unknownEntry = join(exports.directory, 'desktop.ini');
  writeFileSync(unknownEntry, '[.ShellClassInfo]\n');

  const job = await exports.begin({}, null);
  const settled = await exports.whenSettled(job.exportId);
  assert.equal(settled?.phase, 'ready', `unexpected error: ${settled?.error}`);
  assert.equal(readFileSync(unknownEntry, 'utf8'), '[.ShellClassInfo]\n');
});
