import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyGroupedReleaseAttestations } from './release-identity.mjs';
import { freezePromotionProduct } from './promotion-snapshot.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = 'a'.repeat(40);
const bundle = (subjects) =>
  Buffer.from(
    JSON.stringify({
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(
          JSON.stringify({ _type: 'https://in-toto.io/Statement/v1', subject: subjects }),
        ).toString('base64'),
      },
    }),
  );
const subject = (name, data) => ({ name, digest: { sha256: hash(Buffer.from(data)) } });

test('same signed bytes share one gh verification, every named snapshot is checked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-group-proof-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'one'), 'first');
  await writeFile(join(dir, 'two'), 'second');
  const bytes = bundle([subject('one', 'first'), subject('two', 'second')]);
  await writeFile(join(dir, 'proof-a'), bytes);
  await writeFile(join(dir, 'proof-b'), bytes);
  const subjects = [
    { file: join(dir, 'one'), sourceSha: sha, bundle: join(dir, 'proof-a') },
    { file: join(dir, 'two'), sourceSha: sha, bundle: join(dir, 'proof-b') },
  ];
  const calls = [];
  const fakeGh = async (_name, args) => {
    calls.push(args);
  };
  assert.deepEqual(await verifyGroupedReleaseAttestations(subjects, fakeGh), {
    groups: 1,
    calls: 1,
  });
  assert.equal(calls[0][calls[0].indexOf('--source-ref') + 1], 'refs/heads/main');
  assert.equal(calls[0][calls[0].indexOf('--source-digest') + 1], sha);
  assert.match(
    calls[0][calls[0].indexOf('--signer-workflow') + 1],
    /release-qualification\.yml@refs\/heads\/main$/,
  );
  await writeFile(join(dir, 'two'), 'changed');
  await assert.rejects(verifyGroupedReleaseAttestations(subjects, fakeGh), /字节不一致/);
  await writeFile(join(dir, 'two'), 'second');
  await writeFile(
    join(dir, 'proof-a'),
    bundle([subject('one', 'first'), subject('two', 'second'), subject('two', 'second')]),
  );
  await assert.rejects(verifyGroupedReleaseAttestations(subjects, fakeGh), /重复/);
  await writeFile(join(dir, 'proof-a'), bytes);
  await assert.rejects(
    verifyGroupedReleaseAttestations(subjects, async () => {
      await writeFile(join(dir, 'proof-b'), 'changed');
    }),
    /bundle 已变化/,
  );
  await writeFile(join(dir, 'proof-b'), bytes);
  await assert.rejects(
    verifyGroupedReleaseAttestations(subjects, async () => {
      await writeFile(join(dir, 'one'), 'raced');
    }),
    /字节不一致/,
  );
});

test('different original bundle bytes and workflow/source identities remain separate', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-group-separate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'one'), 'first');
  await writeFile(join(dir, 'two'), 'second');
  await writeFile(join(dir, 'a'), bundle([subject('one', 'first')]));
  await writeFile(join(dir, 'b'), bundle([subject('two', 'second')]));
  const subjects = [
    { file: join(dir, 'one'), sourceSha: sha, bundle: join(dir, 'a') },
    {
      file: join(dir, 'two'),
      sourceSha: 'b'.repeat(40),
      bundle: join(dir, 'b'),
      workflow: 'promotion',
    },
  ];
  const distinctBundles = subjects.map((entry) => ({
    ...entry,
    sourceSha: sha,
    workflow: 'qualification',
  }));
  assert.deepEqual(await verifyGroupedReleaseAttestations(distinctBundles, async () => {}), {
    groups: 2,
    calls: 2,
  });
  const calls = [];
  assert.deepEqual(
    await verifyGroupedReleaseAttestations(subjects, async (_name, args) => calls.push(args)),
    { groups: 2, calls: 2 },
  );
  assert.match(
    calls[1][calls[1].indexOf('--signer-workflow') + 1],
    /release-promotion\.yml@refs\/heads\/main$/,
  );
  assert.equal(calls[1][calls[1].indexOf('--source-digest') + 1], 'b'.repeat(40));
  await assert.rejects(
    verifyGroupedReleaseAttestations(subjects, async () => {
      throw new Error('invalid signature or workflow');
    }),
    /gh attestation verification failed/,
  );
});

test('promotion uses frozen bytes and removes snapshot when verification fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-promotion-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source);
  const version = '1.10.0';
  const manifest = {
    appVersion: version,
    gitSha: sha,
    archive: `Mizar-v${version}-Windows-x64.zip`,
  };
  const core = { ...manifest, archive: `Mizar-v${version}-Windows-x64-Core.zip` };
  const files = {
    'release-manifest.json': JSON.stringify(manifest),
    'core-release-manifest.json': JSON.stringify(core),
    'distribution-manifest.json': JSON.stringify({
      archive: `Mizar-v${version}-Windows-x64-Setup.exe`,
    }),
    'core-distribution-manifest.json': '{}',
    [manifest.archive]: 'full',
    [core.archive]: 'core',
    [core.archive.replace(/\.zip$/, '-Setup.exe')]: 'core-setup',
    [`Mizar-v${version}-Windows-x64-Setup.exe`]: 'setup',
    [`Mizar-v${version}-Windows-x64-WebInstaller.exe`]: 'web',
    'web-installer-build.json': '{}',
    'update-manifest.json': '{}',
    'qualification-provenance.json': 'proof',
    'update-provenance.json': 'proof',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(source, name), content);
  const destination = join(dir, 'frozen');
  const result = await freezePromotionProduct(
    source,
    destination,
    sha,
    `v${version}`,
    async (subjects) => {
      assert.equal(subjects.length, 11);
    },
  );
  assert.equal(result.subjectCount, 11);
  await writeFile(join(source, manifest.archive), 'changed');
  assert.equal(await readFile(join(destination, manifest.archive), 'utf8'), 'full');
  const failed = join(dir, 'failed');
  await assert.rejects(
    freezePromotionProduct(source, failed, sha, `v${version}`, async () => {
      throw new Error('reject');
    }),
  );
  await assert.rejects(readFile(join(failed, manifest.archive)), { code: 'ENOENT' });
});
