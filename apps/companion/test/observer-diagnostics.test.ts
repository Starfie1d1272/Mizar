import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { startObserverProcess } from '../src/telemetry/observer-process.js';
import { createObserverSourceManager } from '../src/telemetry/cstv-source-manager.js';
import { ObserverSettingsStore } from '../src/telemetry/observer-settings.js';
import { SessionJournal } from '../src/support/session-journal.js';
import { SupportExports } from '../src/support/export-job.js';
import { runArchiveWorker } from '../src/support/archive-worker.js';
import { technicalProjection } from '../src/support/technical-projection.js';
import { errorEvidence } from '../src/updates/diagnostics.js';

test('next-map connect requires new GoTV endpoints and reuses the accepted request on retry', () => {
  const settings = new ObserverSettingsStore();
  const original = {
    earlyEndpoint: '127.0.0.25:27025',
    programEndpoint: '127.0.0.25:27026',
    password: 'first-map',
  };
  const next = {
    earlyEndpoint: '127.0.0.26:27025',
    programEndpoint: '127.0.0.26:27026',
    password: 'second-map',
  };
  settings.setMapConnection('first', 'connect', original);
  assert.throws(
    () => settings.setMapConnection('next', 'connect', undefined, true),
    /next_map_connection_required/,
  );
  assert.throws(
    () => settings.setMapConnection('next', 'connect', original, true),
    /next_map_connection_required/,
  );
  settings.setMapConnection('next', 'connect', next, true);
  const revision = settings.revision;
  settings.setMapConnection('next', 'connect', next, true);
  assert.equal(settings.revision, revision);
  assert.deepEqual(settings.configured(), next);
});

test('diagnostic coverage exceeding the ZIP entry limit is exported in indexed shards', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'mizar-coverage-overflow-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const gaps = Array.from({ length: 3500 }, (_, index) => ({
    source: `session-${index}.ndjson`,
    reason: 'source_not_safely_fixed',
    cause: { stack: 'fixed-source check\n'.repeat(40) },
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(gaps)) > 2 * 1024 * 1024);
  let result: Record<string, unknown> | undefined;
  runArchiveWorker(
    { sources: [], gaps, output, exportId: 'test', range: {}, snapshot: {} },
    (message) => {
      result = message;
    },
  );
  assert.equal(result?.phase, 'ready');
  assert.equal(result?.knownGaps, gaps.length);
  const zip = unzipSync(await readFile(join(output, 'part-1.zip')));
  const coverage = JSON.parse(Buffer.from(zip['coverage.json']!).toString());
  assert.equal(coverage.gapCount, gaps.length);
  const details = coverage.coverageFiles.flatMap(({ name }: { name: string }) =>
    Buffer.from(zip[name]!)
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
  );
  assert.deepEqual(
    details.map((entry: { value: unknown }) => entry.value),
    gaps,
  );
});

test('managed v2 keeps channel, world and public sequence authority at stream boundaries', async () => {
  const source = 'ahead:observer';
  const manager = createObserverSourceManager({
    role: 'lookahead',
    identity: { source, role: 'ahead', channel: 0, world: 1 },
    clock: { now: () => ({ observedAt: new Date().toISOString(), observedMonotonicMs: 1000 }) },
  });
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/observer-event.json', import.meta.url), 'utf8'),
  );
  const seen: number[] = [];
  manager.subscribeLiveGameEvents(({ cursor }) => seen.push(cursor.sequence));
  manager.start();
  const write = (sequence: number, row: object, channel = 1, world = 1) =>
    manager.consumeObserverRecord({ ...row, source, sequence, channel, world });
  const begin = { kind: 'session-start', protocol: 2 };
  const cursor = {
    kind: 'cursor',
    tick: 100,
    committedTick: 100,
    tickInterval: 1 / 64,
    map: 'de_test',
  };

  write(1, cursor);
  assert.equal(manager.getHealth().state, 'connecting');
  write(1, begin);
  write(2, { kind: 'future-record' });
  write(3, cursor);
  write(4, {
    ...fixture,
    sdkQueueAgeUs: 700,
    dequeueToSubmitUs: 100,
    submitToObservedUs: 1000,
    resultQueueUs: 300,
    supervisorForwardUs: 200,
  });
  write(4, fixture);
  assert.deepEqual(seen, [4]);
  assert.equal(manager.getRecentGameEvents()[0]?.cursor.sourceArrivalMonotonicMs, 998);

  write(5, { kind: 'discontinuity', scope: 'world' }, 1, 2);
  write(6, fixture, 1, 2);
  write(50, cursor);
  assert.equal(manager.getHealth().state, 'connecting');
  assert.deepEqual(manager.getRecentGameEvents(), []);
  write(7, cursor, 1, 2);
  write(8, fixture, 1, 2);
  write(9, { kind: 'discontinuity', scope: 'connection' }, 1, 2);
  write(50, cursor, 1, 2);
  assert.equal(manager.getHealth().state, 'reconnecting');
  write(10, begin, 2);
  write(11, { ...cursor, observedAt: Date.now() - 3000 }, 2);
  write(12, fixture, 2);
  assert.equal(manager.getHealth().state, 'connecting');
  write(13, cursor, 2);
  write(14, fixture, 2);
  assert.deepEqual(seen, [4, 8, 14]);
  assert.equal(manager.getRecentGameEvents().at(-1)?.cursor.sourceArrivalMonotonicMs, undefined);
  const live = manager.getHealth();
  write(15, { kind: 'discontinuity', scope: 'connection', reason: 'source-hltv-stop' }, 2);
  write(16, fixture, 2);
  manager.disconnectObserver('ended');
  assert.equal(manager.getHealth().normalDrain, undefined);
  manager.confirmObserverDrain();
  assert.equal(manager.getHealth().normalDrain, true);
  assert.equal(manager.getHealth().generation, live.generation);
  assert.deepEqual(seen, [4, 8, 14]);
  await manager.stop();
  assert.equal(manager.getHealth().normalDrain, undefined);
  write(17, fixture, 2);
  assert.deepEqual(seen, [4, 8, 14]);
});

test('component failure survives local journal and actual support ZIP without credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  const reports = join(root, 'data', 'observer');
  await mkdir(logs);
  await mkdir(reports, { recursive: true });
  const outputDirectory = join(reports, randomUUID());
  const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
  const password = 'diagnostic-test-private-password';
  const owner = startObserverProcess({
    role: 'lookahead',
    python: process.execPath,
    driver,
    native: driver,
    steamApi: driver,
    node: process.execPath,
    parserWorker: driver,
    outputDirectory,
    hostVersion: 14197,
    endpoint: '127.0.0.25:27020',
    password,
  });
  t.after(() => owner.stop());
  const result = await owner.closed;
  assert.equal(result.failed, true);
  assert.match(result.terminal.detail ?? '', /unsupported serializer test_field/);
  assert.match(result.terminal.detail ?? '', /root-cause-at-end/);
  assert(!JSON.stringify(result.terminal).includes(password));
  assert.equal(result.terminal.hostVersion, 14197);
  const journal = new SessionJournal(logs);
  t.after(() => journal.close());
  await journal.recordCommitted('observer_attempt_terminal', result.terminal);
  const ticket = randomUUID();
  const failure = Object.assign(
    new Error('download failed; password=' + password + '; expected catalog.json', {
      cause: new AggregateError(
        Array.from({ length: 8 }, (_, i) => new Error(`transport cause ${i}`)),
        'all sources failed',
      ),
    }),
    { path: 'C:\\Users\\operator\\Mizar\\catalog.json', outputTokenConfigured: true },
  );
  const validation = Object.assign(new Error(password), {
    name: 'ZodError',
    issues: [{ code: 'invalid_type', path: ['password'], input: password, expected: 'string' }],
  });
  await journal.recordCommitted('local_diagnostic_context', {
    outputTokenConfigured: true,
    gsiTokenConfigured: false,
    connection: { passwordProvided: true, password },
    ticket,
    error: errorEvidence(failure),
    validation: errorEvidence(new Error('configuration validation', { cause: validation })),
    nested: { kind: 'program_all_chat', evidence: { text: 'private-chat-marker' } },
  });
  await journal.recordCommitted('cs2_console_records', {
    readError: 'file_changed_after_read',
    cursor: 714,
    records: [{ sourceRecordId: 'console-test-record', text: 'synthetic engine failure' }],
  });

  // A historical component report must survive even when its journal has rotated.
  const oldId = randomUUID();
  await mkdir(join(reports, oldId));
  await writeFile(
    join(reports, oldId, 'report.json'),
    JSON.stringify({
      schema: 'cs2-observer-report/1',
      reason: 'ordered-parser-error: historical_field',
      password,
      native_boot_code: 5,
      steam_init_result: 0,
      cleanupCompleted: true,
    }),
  );
  const exports = new SupportExports(logs, () => [journal.exportParticipant()]);
  const job = await exports.begin({}, {});
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  assert.equal(status.settled, true);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  const report = entries[`attachments/observer/${oldId}/report.json`];
  assert(report, Buffer.from(entries['coverage.json']!).toString());
  const attachment = JSON.parse(Buffer.from(report).toString());
  assert.equal(attachment.reason, 'ordered-parser-error: historical_field');
  assert.equal(attachment.password, '[redacted]');
  const events = Object.entries(entries)
    .filter(([name]) => name.startsWith('events/'))
    .flatMap(([, bytes]) =>
      Buffer.from(bytes)
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  const terminal = events.find((event) => event.kind === 'observer_attempt_terminal');
  assert.match(terminal.evidence.detail, /unsupported serializer test_field/);
  assert.match(terminal.evidence.detail, /root-cause-at-end/);
  const context = events.find((event) => event.kind === 'local_diagnostic_context').evidence;
  assert.equal(context.outputTokenConfigured, true);
  assert.equal(context.gsiTokenConfigured, false);
  assert.equal(context.connection.passwordProvided, true);
  assert.equal(context.connection.password, '[redacted]');
  assert.equal(
    context.ticket,
    `[redacted-ticket:${createHash('sha256').update(ticket).digest('hex')}]`,
  );
  assert.match(context.error.message, /expected catalog.json/);
  assert.equal(context.error.cause.errors[7].message, 'transport cause 7');
  assert.equal(context.error.path, failure.path);
  assert.equal(context.validation.cause.issues[0].code, 'invalid_type');
  const consoleContext = events.find(
    (event) => event.kind === 'console_carrier_reference',
  ).evidence;
  assert.equal(consoleContext.readError, 'file_changed_after_read');
  assert.equal(consoleContext.cursor, 714);
  assert.equal(consoleContext.eventRefs.length, 1);
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(password)));
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(ticket)));
  assert(
    !Object.values(entries).some((bytes) => Buffer.from(bytes).includes('private-chat-marker')),
  );
  const cloud = technicalProjection(terminal, '2020-01-01T00:00:00Z');
  assert.deepEqual(cloud.evidence, terminal.evidence);
  assert.match(JSON.stringify(cloud), /unsupported serializer/);
});

test('pre-report and protocol failures survive the real export; overflow retains a prefix and a gap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-stream-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  const reports = join(root, 'data', 'observer');
  await mkdir(logs);
  await mkdir(reports, { recursive: true });
  const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
  const password = 'diagnostic-stream-private-password';
  const journal = new SessionJournal(logs);
  t.after(() => journal.close());
  for (const host of [13, 26, 27, 28]) {
    const owner = startObserverProcess({
      role: 'lookahead',
      python: process.execPath,
      driver,
      native: driver,
      steamApi: driver,
      node: process.execPath,
      parserWorker: driver,
      outputDirectory: join(reports, randomUUID()),
      hostVersion: 14197,
      endpoint: `127.0.0.${host}:27020`,
      password,
    });
    t.after(() => owner.stop());
    const { terminal } = await owner.closed;
    await journal.recordCommitted('observer_attempt_terminal', terminal);
  }
  const exports = new SupportExports(logs, () => [journal.exportParticipant()]);
  const job = await exports.begin({}, {});
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  const events = Object.entries(entries)
    .filter(([name]) => name.startsWith('events/'))
    .flatMap(([, bytes]) =>
      Buffer.from(bytes)
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  const failures = events
    .filter((event) => event.kind === 'observer_attempt_terminal')
    .map((event) => event.evidence);
  assert(
    failures.some((failure) =>
      failure.stderr.text.includes('Traceback private path and [redacted]'),
    ),
  );
  assert(
    failures.some(
      (failure) => failure.stdout.error?.name === 'SyntaxError' && failure.stdout.error.stack,
    ),
  );
  const overflow = failures.find((failure) => failure.stderr.truncated);
  assert(overflow.stderr.text.startsWith('interpreter-failure-prefix'));
  assert(overflow.stderr.observedBytes > overflow.stderr.retainedBytes);
  const supervisor = failures.find((failure) => failure.reason === 'reconnect-budget-exhausted');
  assert.equal(supervisor?.report, 'received');
  assert.equal(supervisor?.supervisor.state, 'backoff');
  assert.equal(supervisor?.lastOutputSequence, 1);
  assert.equal(supervisor?.stderr.truncated, true);
  const coverage = JSON.parse(Buffer.from(entries['coverage.json']!).toString());
  assert(coverage.gaps.some((gap: { reason: string }) => gap.reason === 'observer_stderr_budget'));
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(password)));
});

test('support export rejects hard-linked or invalid observer reports and records the gaps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-report-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  const reports = join(root, 'data', 'observer');
  await mkdir(logs);
  await mkdir(reports, { recursive: true });
  const unsafeId = randomUUID(),
    invalidId = randomUUID();
  await mkdir(join(reports, unsafeId));
  await mkdir(join(reports, invalidId));
  const privateFile = join(root, 'unrelated.json');
  await writeFile(privateFile, '{"private":"unrelated-file-marker"}');
  await link(privateFile, join(reports, unsafeId, 'report.json'));
  await writeFile(join(reports, invalidId, 'report.json'), '{"schema":"unsupported"}');
  const exports = new SupportExports(logs);
  const job = await exports.begin({}, {});
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  assert(!Object.keys(entries).some((name) => name.startsWith('attachments/observer/')));
  const coverage = JSON.parse(Buffer.from(entries['coverage.json']!).toString());
  assert(
    coverage.gaps.some((gap: { reason: string }) => gap.reason.includes('resource_path_unsafe')),
  );
  assert(
    coverage.gaps.some((gap: { reason: string }) => gap.reason.includes('observer_report_schema')),
  );
  assert(
    !Object.values(entries).some((bytes) => Buffer.from(bytes).includes('unrelated-file-marker')),
  );
});

test('support ZIP keeps safe fixed segments and reports each unavailable committed segment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-pinned-log-gap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(await realpath(root), 'logs');
  await mkdir(logs);
  const pinId = randomUUID();
  const emptyOld = `desktop-${randomUUID()}.ndjson`;
  const successor = `document-${randomUUID()}.ndjson`;
  const unknown = `document-${randomUUID()}.ndjson`;
  const good = `desktop-${randomUUID()}.ndjson`;
  const missingHost = `desktop-${randomUUID()}.ndjson`;
  const changedHost = `document-${randomUUID()}.ndjson`;
  const unavailableAtPrepare = `document-${randomUUID()}.ndjson`;
  const fixedContent =
    '{"eventId":"safely-fixed-host-event"}\n' +
    '{"eventId":"reported-host-loss","kind":"native_diagnostic_coverage_gap","evidence":{"dropped":2}}\n';
  const fixed = {
    bytes: Buffer.byteLength(fixedContent),
    sha256: createHash('sha256').update(fixedContent).digest('hex'),
  };
  await mkdir(join(logs, 'host-pins'));
  await Promise.all([
    writeFile(join(logs, emptyOld), ''),
    writeFile(join(logs, successor), 'post-cutoff'),
    writeFile(join(logs, unknown), 'unfixed-original'),
    writeFile(join(logs, unavailableAtPrepare), 'unverified-by-host'),
    writeFile(join(logs, good), fixedContent),
    writeFile(join(logs, changedHost), fixedContent.replace('safely', 'edited')),
    writeFile(
      join(logs, 'host-pins', `${pinId}.json`),
      JSON.stringify({
        schema: 'mizar-producer-pin/2',
        pinId,
        producerKind: 'host',
        producerRunId: randomUUID(),
        kind: 'export',
        state: 'committed',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        segments: [missingHost, changedHost, good].map((name) => ({ name, ...fixed })),
        sourceState: {
          asOf: new Date().toISOString(),
          memoryOnly: { events: 0, bytes: 0 },
          unreportedLoss: { overflow: 0, contended: 0, writeFailed: 0 },
          emptyAtCutoffSegments: [emptyOld],
          postCutoffSegments: [successor],
          unavailableSegments: [
            { name: unavailableAtPrepare, reason: 'host_pin_source_read_failed' },
          ],
        },
      }),
    ),
  ]);
  const journal = new SessionJournal(logs);
  t.after(() => journal.close());
  await journal.recordCommitted('before_cutoff', { recorded: true });
  const participant = journal.exportParticipant();
  let missing: string | undefined;
  const exports = new SupportExports(logs, () => [
    {
      ...participant,
      async commit(pinId) {
        const receipt = await participant.commit(pinId);
        missing = receipt.segments[0]?.name;
        assert.ok(missing);
        await rm(join(logs, missing));
        return receipt;
      },
    },
  ]);
  const job = await exports.begin({}, {}, pinId);
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  const coverage = JSON.parse(Buffer.from(entries['coverage.json']!).toString());
  const events = Object.entries(entries)
    .filter(([name]) => name.startsWith('events/'))
    .map(([, bytes]) => Buffer.from(bytes).toString())
    .join('');
  assert.match(events, /safely-fixed-host-event/);
  assert.doesNotMatch(events, /edited-fixed-host-event|unfixed-original|unverified-by-host/);
  const generated = JSON.parse(
    await readFile(join(exports.directory, job.exportId, 'generated.json'), 'utf8'),
  );
  assert.equal(generated.completeKnownSources, false);
  assert.equal(
    coverage.gaps.filter(
      ({ source, phase, reason }: { source: string; phase: string; reason: string }) =>
        source === unavailableAtPrepare &&
        phase === 'prepare' &&
        reason === 'host_pin_source_read_failed',
    ).length,
    1,
  );
  assert.ok(
    coverage.gaps.some(
      (entry: { reason: string; eventId?: string }) =>
        entry.reason === 'native_event_loss_reported' && entry.eventId === 'reported-host-loss',
    ),
  );
  assert.deepEqual(
    coverage.gaps
      .filter((entry: { source: string }) => [missingHost, changedHost].includes(entry.source))
      .map(({ source, phase }: { source: string; phase: string }) => [source, phase]),
    [
      [missingHost, 'read'],
      [changedHost, 'read'],
    ],
  );
  assert.ok(
    coverage.gaps.some(
      (entry: { source: string; phase: string }) =>
        entry.source === missing && entry.phase === 'read',
    ),
  );
  assert.ok(coverage.gaps.some((entry: { source: string }) => entry.source === unknown));
  assert.ok(
    coverage.excludedSources.some(
      (entry: { source: string; reason: string }) =>
        entry.source === emptyOld && entry.reason === 'producer-declared-empty-at-cutoff',
    ),
  );
  assert.ok(
    coverage.excludedSources.some(
      (entry: { source: string; reason: string }) =>
        entry.source === successor && entry.reason === 'producer-declared-post-cutoff-segment',
    ),
  );
});
