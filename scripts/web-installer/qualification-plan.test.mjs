import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { qualificationPlan } from './qualification-plan.mjs';

let root;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const sha = (value) => createHash('sha256').update(value).digest('hex');
const context = {
  repository: 'Starfie1d1272/Mizar',
  ref: 'refs/heads/main',
  sha: 'a'.repeat(40),
  event: 'workflow_dispatch',
  workflowRef: 'Starfie1d1272/Mizar/.github/workflows/release-qualification.yml@refs/heads/main',
};
it('rejects an actual manifest outside main qualification before using its executable pins', async () => {
  root = await mkdtemp(join(tmpdir(), 'mizar installer candidate '));
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ gitSha: context.sha }));
  await expect(
    qualificationPlan(
      root,
      join(root, 'not-present'),
      { ...context, workflowRef: 'Starfie1d1272/Mizar/.github/workflows/ci.yml@refs/heads/main' },
      context.sha,
      context.sha,
    ),
  ).rejects.toThrow('发布工作流必须来自 main');
});
it('builds fixed candidate pins from real separate extracted Core and archive bytes, rejecting subsequent corruption', async () => {
  // Contract fixture, not a signed release or an executable NSIS. The production
  // payload verifier and archive producer are real and are never mocked.
  root = await mkdtemp(join(tmpdir(), 'mizar installer candidate '));
  const product = join(root, 'assembled');
  const extracted = join(root, 'final candidate');
  const bundleName = 'Mizar-v1.1.0-Windows-x64';
  const core = join(extracted, bundleName);
  await mkdir(product, { recursive: true });
  const files = new Map(
    [
      'Mizar.exe',
      'resources/runtime/node.exe',
      'resources/app/dist/server.js',
      'resources/web/dist/index.html',
      'resources/scripts/product-runtime.mjs',
      'resources/scripts/product-logs.mjs',
      'resources/app/dist/web-installer/installed-entry.mjs',
      'resources/app/dist/web-installer/complete-bootstrap.mjs',
      'resources/app/dist/web-installer/install-official-pack.mjs',
      'resources/app/dist/web-installer/published-bootstrap.mjs',
      'resources/app/dist/web-installer/cancel-control.mjs',
    ]
      .sort()
      .map((name) => [name, Buffer.from('contract fixture: ' + name)]),
  );
  const contentDigest = sha([...files].map(([name, bytes]) => `${name}\0${sha(bytes)}\n`).join(''));
  const artifact = {
    repository: context.repository,
    productSchemaVersion: 1,
    desktopHost: 'tauri2',
    platform: 'win32-x64',
    developmentOnly: false,
    desktopBuildProfile: 'release',
    appVersion: '1.1.0',
    gitSha: context.sha,
    artifactSha256: contentDigest,
  };
  files.set('resources/metadata/artifact.json', Buffer.from(JSON.stringify(artifact)));
  files.set(
    'resources/metadata/SHA256SUMS',
    Buffer.from([...files].map(([name, bytes]) => `${sha(bytes)}  ${name}`).join('\n') + '\n'),
  );
  for (const [name, bytes] of files) {
    await mkdir(join(core, name, '..'), { recursive: true });
    await writeFile(join(core, name), bytes);
  }
  const archive = join(product, bundleName + '.zip');
  if (process.platform === 'win32')
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      resolve('scripts/qualification/create-windows-archive.ps1'),
      '-BundleRoot',
      core,
      '-ArchivePath',
      archive,
    ]);
  else execFileSync('zip', ['-q', '-r', archive, bundleName], { cwd: extracted });
  const archiveSha256 = sha(await readFile(archive));
  const name = 'Mizar-v1.1.0-Windows-x64-Setup.exe';
  const nsis = Buffer.from('NSIS identity contract fixture; never executed');
  await writeFile(join(product, name), nsis);
  await writeFile(
    join(product, 'release-manifest.json'),
    JSON.stringify({
      appVersion: '1.1.0',
      gitSha: context.sha,
      archive: bundleName + '.zip',
      archiveSha256,
      contentDigest,
      desktopBuildProfile: 'release',
      developmentOnly: false,
    }),
  );
  await writeFile(
    join(product, 'distribution-manifest.json'),
    JSON.stringify({
      appVersion: '1.1.0',
      gitSha: context.sha,
      originalArchiveSha256: archiveSha256,
      contentDigest,
      format: 'nsis-setup',
      archive: name,
      archiveSha256: sha(nsis),
      archiveBytes: nsis.length,
    }),
  );
  const plan = await qualificationPlan(product, core, context, context.sha, context.sha);
  expect(plan).toMatchObject({
    name,
    sha256: sha(nsis),
    bytes: nsis.length,
    gitSha: context.sha,
    contentDigest,
    coreName: bundleName + '.zip',
    coreSha256: archiveSha256,
    publicationRequired: true,
  });
  await writeFile(join(product, name), 'changed');
  await expect(qualificationPlan(product, core, context, context.sha, context.sha)).rejects.toThrow(
    'Qualified archive or NSIS bytes changed',
  );
  await writeFile(join(product, name), nsis);
  await writeFile(join(core, 'resources/app/dist/web-installer/installed-entry.mjs'), 'changed');
  await expect(qualificationPlan(product, core, context, context.sha, context.sha)).rejects.toThrow(
    '程序文件校验失败',
  );
});
