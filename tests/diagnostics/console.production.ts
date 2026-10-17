/** Cross-language qualification: public synthetic game text only. No account or user capture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  copyFile,
  rm,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { NativeSource } from '../../apps/companion/src/support/native-source.js';
import {
  DiagnosticDelivery,
  decodeDiagnosticBatch,
} from '../../apps/companion/src/support/delivery.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { runtime, migrate, adminHeaders, hash } from './fixture.js';

const repository = resolve(import.meta.dirname, '../..');
const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-console-production-'));
const logs = join(directory, 'client-logs');
const producerOutput = join(directory, 'rust-output');
await mkdir(producerOutput);
let server = runtime(join(directory, 'server'));
let endpoint = (await server.ready).origin;
await migrate(await server.getD1Database('DIAGNOSTICS_DB'));
let journal = new SessionJournal(logs, { appVersion: 'console-test' });
let source = new NativeSource(logs, journal);
let loseAck = true;
let now = Date.now();
const fetcher: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('cf-connecting-ip', '127.0.0.1');
  const response = await fetch(input, { ...init, headers });
  if (loseAck && init?.method === 'PUT' && response.ok) {
    loseAck = false;
    await response.arrayBuffer();
    throw new Error('public synthetic lost ACK after actual R2/D1 commit');
  }
  return response;
};
const makeDelivery = () =>
  new DiagnosticDelivery(logs, journal, {
    endpoint,
    allowTestEndpoint: true,
    fetch: fetcher,
    now: () => now,
  });
let delivery = await makeDelivery().initialize(false);
let app: ReturnType<typeof buildApp> | undefined;
try {
  await delivery.consent(true);
  const manifest =
    process.env.MIZAR_CONSOLE_TEST_MANIFEST ??
    join(repository, 'apps/desktop/src-tauri/Cargo.toml');
  const profile = process.env.MIZAR_CONSOLE_TEST_PROFILE ?? 'ci';
  execFileSync(
    'cargo',
    [
      'test',
      '--locked',
      '--profile',
      profile,
      '--manifest-path',
      manifest,
      'cs2_console::tests::exports_public_fixture_to_the_node_pipeline',
      '--',
      '--exact',
    ],
    {
      cwd: repository,
      env: { ...process.env, MIZAR_CONSOLE_TEST_OUTPUT_DIRECTORY: producerOutput },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const producer = JSON.parse(
    await readFile(join(producerOutput, 'console-producer.json'), 'utf8'),
  ) as {
    records: { sourceRecordId: string; sourceAfterUtc: string; capturedAt: string }[];
  };
  assert.equal(producer.records.length, 2);
  for (const name of await readdir(join(producerOutput, 'logs')))
    await copyFile(join(producerOutput, 'logs', name), join(logs, name));
  await source.poll();
  await journal.flush();
  assert.equal(source.health().failures, 0);
  await delivery.tick();
  assert.equal(delivery.status().acknowledged, 0);
  assert.equal(delivery.status().failures, 1);
  const state = JSON.parse(await readFile(join(logs, 'diagnostic-outbox/state.json'), 'utf8')) as {
    credentials: { installationId: string; enrollmentSecret: string };
    queue: { id: string }[];
  };
  const id = state.queue[0]!.id;
  const database = await server.getD1Database('DIAGNOSTICS_DB');
  const row = await database
    .prepare('SELECT object_key,state FROM batches WHERE id=?')
    .bind(id)
    .first<{ object_key: string; state: string }>();
  assert.equal(row?.state, 'ready');
  const body = await (await server.getR2Bucket('DIAGNOSTICS_BUCKET')).get(row.object_key);
  assert(body);
  const packet = Buffer.from(await body.arrayBuffer());
  assert.equal(hash(packet), id);
  const cloudText = JSON.stringify(await decodeDiagnosticBatch(packet));
  for (const text of [
    'Created device for public fixture',
    'DXGI_ERROR_DEVICE_REMOVED',
    'original-device-removal',
    'sourceAfterUtc',
  ])
    assert(cloudText.includes(text), text);
  for (const text of [
    'PRIVATE_CONSOLE_TOKEN',
    'PRIVATE_CHAT_CONTENT',
    'PRIVATE_UNKNOWN_CONTENT',
    'PRIVATE_PRESESSION_CONTENT',
    state.credentials.enrollmentSecret,
  ])
    assert(!cloudText.includes(text), text);
  const uploaded = body.uploaded.getTime();
  await source.close();
  await delivery.close();
  await journal.close();
  await server.dispose();
  server = runtime(join(directory, 'server'));
  endpoint = (await server.ready).origin;
  now += 60_000;
  journal = new SessionJournal(logs, { appVersion: 'console-test' });
  source = new NativeSource(logs, journal);
  delivery = await makeDelivery().initialize(false);
  await source.poll();
  assert.equal(source.health().copied, 0);
  await delivery.tick();
  assert.equal(delivery.status().acknowledged, 1);
  const repeated = await (await server.getR2Bucket('DIAGNOSTICS_BUCKET')).head(row.object_key);
  assert.equal(repeated?.uploaded.getTime(), uploaded);
  const lookup = await fetch(
    `${endpoint}/admin/sessions?installation=${state.credentials.installationId}&onlyFailures=1`,
    { headers: adminHeaders },
  );
  assert.equal(lookup.status, 200);
  const indexed = (await lookup.json()) as {
    sessions: { failure_kinds: string; failures: number }[];
  };
  assert(
    indexed.sessions.some(
      (session) =>
        session.failures > 0 && (JSON.parse(session.failure_kinds) as string[]).includes('native'),
    ),
  );
  await source.close();
  await delivery.close();
  await journal.close();
  app = buildApp({ supportLogsDirectory: logs });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(address + '/debug/support-bundle', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const bundle = await response.text();
  const path = join(directory, 'public-console-bundle.json');
  await writeFile(path, bundle);
  const output = execFileSync(
    process.execPath,
    [join(repository, 'scripts/diagnostics/read-support-bundle.mjs'), path],
    {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const timeline = output
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          stage?: string;
          complete?: boolean;
          text?: string;
          timestampStatus?: string;
        },
    );
  const lines = timeline.filter((event) => event.stage === 'cs2_console_line');
  assert.equal(lines.length, 2);
  assert(
    lines.every((line) => line.complete === true && line.timestampStatus?.includes('upper bound')),
  );
  assert(lines.some((line) => line.text?.includes('original-device-removal')));
  assert(producer.records[0]!.sourceAfterUtc < producer.records[0]!.capturedAt);
  const interval = await fetch(address + '/debug/support-bundle', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
    body: JSON.stringify({
      from: producer.records[0]!.sourceAfterUtc,
      to: producer.records[0]!.sourceAfterUtc,
    }),
  });
  assert.equal(interval.status, 200);
  await writeFile(path, await interval.text());
  const intervalTimeline = execFileSync(
    process.execPath,
    [join(repository, 'scripts/diagnostics/read-support-bundle.mjs'), path],
    {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { stage?: string });
  assert.equal(intervalTimeline.filter((line) => line.stage === 'cs2_console_line').length, 2);

  for (const value of [
    'PRIVATE_CONSOLE_TOKEN',
    'PRIVATE_CHAT_CONTENT',
    'PRIVATE_UNKNOWN_CONTENT',
    'PRIVATE_PRESESSION_CONTENT',
    state.credentials.enrollmentSecret,
  ])
    assert(!output.includes(value), value);
  assert(!bundle.includes('game/csgo/console.log'));
  process.stdout.write(
    JSON.stringify({
      scope:
        'actual Rust capture/DesktopLog -> NativeSource -> disk/restart -> HTTP Worker/R2/D1 -> actual HTTP support bundle and production reader; public synthetic console, separate process-identity tests, not real CS2',
      rustTarget: process.platform,
      technicalLines: lines.length,
      normalAndFailurePreserved: true,
      rawChatUnknownPreSessionAndCredentialsExcluded: true,
      restartDidNotDuplicate: true,
      lostAckRecoveredWithoutNewObjectOrRetentionClock: true,
      failureIndexed: true,
      exactEngineEventTimeClaimed: false,
      sourceWriteIntervalPreserved: true,
      explicitRangeUsesSourceIntervalInsteadOfCollectionClock: true,
      externalAccountRequests: 0,
    }) + '\n',
  );
} finally {
  if (app) await app.close();
  await source.close();
  await delivery.close();
  await journal.close();
  await server.dispose();
  await rm(directory, { recursive: true, force: true });
}
