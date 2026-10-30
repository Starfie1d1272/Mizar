import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { lookupCreatedDraft, lookupRelease } from './release-lookup.mjs';
import { publishDraftAssets, reconcileAssets, stageDraftAssets } from './release-assets.mjs';

const sha = 'a'.repeat(40);
const tag = 'v1.10.1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const missingTag = () =>
  Object.assign(new Error('Not found'), { stderr: Buffer.from('(HTTP 404)') });

function draftApi(expected, initial = []) {
  const files = new Map(
    initial.map((asset, index) => [asset.name, { id: index + 1, bytes: asset.bytes }]),
  );
  const calls = [];
  const actions = [];
  let failAfterUpload = false;
  let published = false;
  let publishedSha = sha;
  let corruptReads = false;
  const release = () => ({
    id: 81,
    draft: !published,
    prerelease: false,
    tag_name: tag,
    target_commitish: sha,
    ...(published ? { published_at: '2026-01-01T00:00:00Z' } : {}),
    assets: [...files].map(([name, item]) => ({
      id: item.id,
      name,
      state: 'uploaded',
      size: item.bytes.length,
      digest: `sha256:${hash(item.bytes)}`,
      ...(published
        ? {
            browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${name}`,
          }
        : {}),
    })),
  });
  const api = (args) => {
    const last = args.at(-1);
    if (args[0] === '--method' && args[1] === 'PATCH') {
      actions.push('publish');
      published = true;
      return Buffer.from('{}');
    }
    if (last.includes('/git/ref/tags/')) {
      if (!published) throw missingTag();
      return Buffer.from(JSON.stringify({ object: { type: 'commit', sha: publishedSha } }));
    }
    if (last.includes('/releases/tags/')) return Buffer.from(JSON.stringify(release()));
    if (last.endsWith('/releases/81')) return Buffer.from(JSON.stringify(release()));
    if (last.includes('/releases/assets/')) {
      const id = Number(last.split('/').at(-1));
      const bytes = [...files.values()].find((item) => item.id === id).bytes;
      return corruptReads ? Buffer.alloc(bytes.length) : bytes;
    }
    if (last.startsWith('https://uploads.github.com/')) {
      const name = new URL(last).searchParams.get('name');
      const entry = expected.find((asset) => asset.name === name);
      calls.push(name);
      files.set(name, { id: files.size + 1, bytes: entry.bytes });
      if (failAfterUpload) {
        failAfterUpload = false;
        throw new Error('connection lost after write');
      }
      return Buffer.from('{}');
    }
    throw new Error('Unexpected fake API');
  };
  return {
    api,
    calls,
    actions,
    release,
    failNextUpload: () => {
      failAfterUpload = true;
    },
    corruptReads: () => {
      corruptReads = true;
    },
    wrongPublishedSha: () => {
      publishedSha = 'b'.repeat(40);
    },
  };
}

test('discovers an unpublished draft, rejects ambiguity and never assumes a failed list is empty', () => {
  const draft = {
    id: 81,
    draft: true,
    prerelease: false,
    tag_name: tag,
    target_commitish: sha,
    assets: [],
  };
  const lookup = (path) => (path.startsWith('releases?') ? [draft] : null);
  assert.equal(lookupRelease(tag, sha, lookup).id, 81);
  const unrelated = Array.from({ length: 100 }, (_, index) => ({
    id: index + 100,
    tag_name: `v0.0.${index}`,
  }));
  assert.equal(
    lookupRelease(tag, sha, (path) =>
      path.endsWith('&page=1') ? unrelated : path.endsWith('&page=2') ? [draft] : null,
    ).id,
    81,
  );
  assert.throws(() =>
    lookupRelease(tag, sha, (path) => (path.startsWith('releases?') ? [draft, draft] : null)),
  );
  assert.throws(() =>
    lookupRelease(tag, sha, (path) =>
      path.startsWith('releases?') ? [{ ...draft, target_commitish: 'b'.repeat(40) }] : null,
    ),
  );
  assert.throws(() => lookupRelease(tag, sha, () => null));
  assert.throws(() =>
    lookupRelease(tag, sha, (path) =>
      path.startsWith('releases?') ? [draft] : { object: { type: 'commit', sha } },
    ),
  );
});

test('new draft lookup waits for visibility but fails closed on absence and conflicts', async () => {
  const draft = {
    id: 81,
    draft: true,
    prerelease: false,
    tag_name: tag,
    target_commitish: sha,
    assets: [],
  };
  let lists = 0;
  let waits = 0;
  const wait = async () => {
    waits++;
  };
  const delayed = (path) => (path.startsWith('releases?') ? (++lists < 3 ? [] : [draft]) : null);
  assert.deepEqual(await lookupCreatedDraft(tag, sha, delayed, wait), draft);
  assert.equal(waits, 2);
  waits = 0;
  await assert.rejects(
    lookupCreatedDraft(tag, sha, (path) => (path.startsWith('releases?') ? [] : null), wait),
    /not visible/,
  );
  assert.equal(waits, 4);
  waits = 0;
  await assert.rejects(
    lookupCreatedDraft(
      tag,
      sha,
      (path) =>
        path.startsWith('releases?') ? [{ ...draft, target_commitish: 'b'.repeat(40) }] : null,
      wait,
    ),
    /Draft source differs/,
  );
  assert.equal(waits, 0);
});

test(
  'production lookup-release finds an authenticated partial draft without a tag',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-lookup-test-'));
    try {
      const gh = join(dir, 'gh');
      await writeFile(
        gh,
        `#!${process.execPath}\nconst path=process.argv[3];\nif(path.includes('/releases?')) console.log(process.env.FAKE_RELEASE_LIST);\nelse if(path.includes('/git/ref/tags/')) { console.error('(HTTP 404)'); process.exit(1); }\nelse process.exit(2);\n`,
      );
      await chmod(gh, 0o700);
      const draft = {
        id: 81,
        draft: true,
        prerelease: false,
        tag_name: tag,
        target_commitish: sha,
        assets: [{ name: 'a.zip' }],
      };
      const manifest = join(dir, 'manifest.json'),
        output = join(dir, 'release.json'),
        envFile = join(dir, 'github-env');
      await writeFile(
        manifest,
        JSON.stringify({
          gitSha: sha,
          archiveSha256: 'b'.repeat(64),
          desktopBuildProfile: 'release',
          developmentOnly: false,
          resourceMode: 'full',
          appVersion: '1.10.1',
          archive: 'Mizar-v1.10.1-Windows-x64.zip',
        }),
      );
      const script = fileURLToPath(new URL('../ci/resource-release.mjs', import.meta.url));
      await promisify(execFile)(
        process.execPath,
        [script, 'lookup-release', dir, manifest, output],
        {
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_ENV: envFile,
            RELEASE_TAG: tag,
            FAKE_RELEASE_LIST: JSON.stringify([draft]),
          },
        },
      );
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), draft);
      assert.match(await readFile(envFile, 'utf8'), /RELEASE_FOUND=true/);
      const createdOutput = join(dir, 'created-release.json');
      await promisify(execFile)(
        process.execPath,
        [script, 'lookup-created-draft', dir, manifest, createdOutput],
        {
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_ENV: envFile,
            RELEASE_TAG: tag,
            FAKE_RELEASE_LIST: JSON.stringify([draft]),
          },
        },
      );
      assert.deepEqual(JSON.parse(await readFile(createdOutput, 'utf8')), draft);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('draft recovery checks existing bytes first, fills only missing files, and survives an uncertain write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-draft-test-'));
  try {
    const expected = await Promise.all(
      ['a.zip', 'b.exe'].map(async (name) => {
        const bytes = Buffer.from(`original-${name}`),
          path = join(dir, name);
        await writeFile(path, bytes);
        return { name, path, bytes, size: bytes.length, sha256: hash(bytes) };
      }),
    );
    const identity = { tag, gitSha: sha };
    const conflict = draftApi(expected, [{ name: 'b.exe', bytes: Buffer.from('wrong') }]);
    await assert.rejects(
      stageDraftAssets('81', identity, expected, conflict.api),
      /metadata differs/,
    );
    assert.deepEqual(conflict.calls, []);
    const corrupt = draftApi(expected, [expected[1]]);
    corrupt.corruptReads();
    await assert.rejects(publishDraftAssets('81', identity, expected, corrupt.api), /bytes differ/);
    assert.deepEqual(corrupt.calls, []);
    assert.deepEqual(corrupt.actions, []);
    const box = draftApi(expected, [expected[0]]);
    box.failNextUpload();
    await assert.rejects(publishDraftAssets('81', identity, expected, box.api), /connection lost/);
    assert.deepEqual(box.actions, []);
    const result = await publishDraftAssets('81', identity, expected, box.api);
    assert.deepEqual(box.calls, ['b.exe']);
    assert.deepEqual(box.actions, ['publish']);
    assert.equal(result.release.id, 81);
    assert.equal(result.ref.object.sha, sha);
    const wrongRef = draftApi(expected, expected);
    wrongRef.wrongPublishedSha();
    await assert.rejects(publishDraftAssets('81', identity, expected, wrongRef.api), /身份不一致/);
    const ref = { object: { type: 'commit', sha } };
    const published = {
      ...box.release(),
      draft: false,
      published_at: '2026-01-01T00:00:00Z',
      assets: box.release().assets.map((asset) => ({
        ...asset,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${asset.name}`,
      })),
    };
    await reconcileAssets(
      published,
      ref,
      identity,
      expected,
      async (name) => readFile(join(dir, name)),
      async () => {
        throw new Error('Unexpected upload');
      },
    );
    await assert.rejects(
      reconcileAssets(
        published,
        { object: { type: 'commit', sha: 'b'.repeat(40) } },
        identity,
        expected,
        async () => Buffer.alloc(0),
        async () => {},
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
