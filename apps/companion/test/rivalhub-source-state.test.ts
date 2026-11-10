import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RivalHubSourceState,
  type SourceScope,
} from '../src/match-context/rivalhub-source-state.js';

const scope: SourceScope = {
  baseUrl: 'https://example.com',
  competitionId: 'competition',
  installationId: 'installation',
  matchId: 'match-a',
  producerInstanceId: 'producer',
  liveSessionId: 'live-a',
};
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-source-state-'));
  const path = join(dir, 'source.json');
  const owners: RivalHubSourceState[] = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    await rm(dir, { recursive: true, force: true });
  });
  const open = (fault?: ConstructorParameters<typeof RivalHubSourceState>[1]) => {
    const owner = new RivalHubSourceState(path, fault);
    owners.push(owner);
    return owner;
  };
  return { path, open };
}

test('claim intent and exact identity survive restart without restoring sending authority', async (t) => {
  const { open } = await setup(t);
  const first = open();
  await first.load();
  const intent = await first.beginClaim(scope, null);
  await first.close();
  const restarted = open();
  assert.deepEqual((await restarted.load()).intent, intent);
  await assert.rejects(restarted.beginClaim(scope, null), /reconciliation/);
  const identity = await restarted.confirmClaim(intent.id, 7);
  await restarted.close();
  const last = open();
  assert.equal((await last.load()).records[0]?.state, 'owned');
  await last.recover();
  assert.deepEqual((await last.snapshot()).records[0], {
    identity,
    state: 'release_pending',
    cause: 'recovery',
    attempts: 0,
    nextAttemptAt: null,
    lastFailureCode: null,
  });
});

test('atomic write failure preserves disk and memory, and unsafe state is rejected', async (t) => {
  const { path, open } = await setup(t);
  let fail = false;
  const store = open((point) => {
    if (fail && point === 'before-rename') throw new Error('injected');
  });
  await store.load();
  const intent = await store.beginClaim(scope, null);
  const before = await readFile(path);
  fail = true;
  await assert.rejects(store.confirmClaim(intent.id, 1), /injected/);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual((await store.snapshot()).intent, intent);
  fail = false;
  await store.clearIntent(intent.id);
  await assert.rejects(
    store.beginClaim({ ...scope, baseUrl: 'https://user:secret@example.com' }, null),
  );
  assert.equal((await readFile(path, 'utf8')).includes('secret'), false);
  await store.close();
  await writeFile(path, '{"version":1,"records":[],"intent":null,"credential":"secret"}');
  await assert.rejects(open().load(), { name: 'ZodError' });
});

test('full pending state refuses a new claim without evicting identities', async (t) => {
  const { path, open } = await setup(t);
  const records = Array.from({ length: 64 }, (_, index) => ({
    identity: { ...scope, matchId: `match-${index}`, authorityRevision: index + 1 },
    state: 'release_pending',
    cause: 'switch',
    attempts: 0,
    nextAttemptAt: null,
    lastFailureCode: null,
  }));
  await writeFile(path, JSON.stringify({ version: 1, records, intent: null }));
  const store = open();
  await store.load();
  const before = await readFile(path);
  await assert.rejects(store.beginClaim(scope, null), /capacity/);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await store.snapshot()).records.length, 64);
});

test('concurrent claims serialize and retain one unresolved intent', async (t) => {
  const { open } = await setup(t);
  const store = open();
  await store.load();
  const outcomes = await Promise.allSettled([
    store.beginClaim(scope, null),
    store.beginClaim(scope, null),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  assert.ok((await store.snapshot()).intent);
});

test('a pending source cannot become evidence for a later claim', async (t) => {
  const { open } = await setup(t);
  const store = open();
  await store.load();
  const intent = await store.beginClaim(scope, null);
  const identity = await store.confirmClaim(intent.id, 1);
  await store.handoff(identity, 'finish');
  await assert.rejects(store.beginClaim(scope, null), /cleanup/);
  assert.equal((await store.snapshot()).intent, null);
});
