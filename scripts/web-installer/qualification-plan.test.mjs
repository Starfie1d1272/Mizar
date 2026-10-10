import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { qualifiedUpdateManifest } from '../qualification/update-manifest.mjs';
import { qualificationPlan } from './qualification-plan.mjs';
import { readAppVersion } from '../qualification/app-version.mjs';

let root;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const sha = (value) => createHash('sha256').update(value).digest('hex');
const context = {
  repository: 'Starfie1d1272/Mizar',
  ref: 'refs/heads/main',
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
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
  const version = await readAppVersion();
  const bundleName = `Mizar-v${version}-Windows-x64-Core`;
  const core = join(extracted, bundleName);
  await mkdir(product, { recursive: true });
  const files = new Map(
    [
      'Mizar.exe',
      'resources/runtime/node.exe',
      'resources/app/package.json',
      'resources/app/dist/updates/contract.js',
      'resources/app/dist/server.js',
      'resources/web/dist/index.html',
      'resources/scripts/product-runtime.mjs',
      'resources/scripts/product-logs.mjs',
      'resources/app/dist/web-installer/installed-entry.mjs',
      'resources/app/dist/web-installer/complete-bootstrap.mjs',
      'resources/app/dist/web-installer/install-official-pack.mjs',
      'resources/app/dist/web-installer/published-bootstrap.mjs',
      'resources/app/dist/web-installer/resource-mirror.mjs',
      'resources/app/dist/web-installer/cancel-control.mjs',
    ]
      .sort()
      .map((name) => [
        name,
        Buffer.from(
          name.endsWith('/contract.js')
            ? "export const BOX_READ_TOKEN = 'public-read-token-fixture';"
            : name.endsWith('/package.json')
              ? '{"type":"module"}'
              : 'contract fixture: ' + name,
        ),
      ]),
  );
  const contentDigest = sha([...files].map(([name, bytes]) => `${name}\0${sha(bytes)}\n`).join(''));
  const artifact = {
    repository: context.repository,
    productSchemaVersion: 1,
    desktopHost: 'tauri2',
    platform: 'win32-x64',
    resourceMode: 'core',
    developmentOnly: false,
    desktopBuildProfile: 'release',
    appVersion: version,
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
  const name = bundleName + '-Setup.exe';
  const nsis = Buffer.from('NSIS identity contract fixture; never executed');
  await writeFile(join(product, name), nsis);
  await writeFile(
    join(product, 'release-manifest.json'),
    JSON.stringify({
      appVersion: version,
      gitSha: context.sha,
      archive: `Mizar-v${version}-Windows-x64.zip`,
      archiveSha256,
      contentDigest,
      desktopBuildProfile: 'release',
      developmentOnly: false,
    }),
  );
  await writeFile(
    join(product, 'distribution-manifest.json'),
    JSON.stringify({
      appVersion: version,
      gitSha: context.sha,
      originalArchiveSha256: archiveSha256,
      contentDigest,
      format: 'nsis-setup',
      archive: `Mizar-v${version}-Windows-x64-Setup.exe`,
      archiveSha256: sha(nsis),
      archiveBytes: nsis.length,
    }),
  );
  await expect(
    qualificationPlan(product, core, context, context.sha, context.sha),
  ).rejects.toThrow();
  const full = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  await writeFile(
    join(product, 'core-release-manifest.json'),
    JSON.stringify({
      ...full,
      resourceMode: 'core',
      archive: bundleName + '.zip',
      derivedFrom: { archiveSha256: full.archiveSha256 },
    }),
  );
  const originalDistribution = JSON.parse(
    await readFile(join(product, 'distribution-manifest.json')),
  );
  await writeFile(
    join(product, 'core-distribution-manifest.json'),
    JSON.stringify({ ...originalDistribution, archive: name }),
  );
  await writeFile(
    join(product, 'update-manifest.json'),
    JSON.stringify(await qualifiedUpdateManifest(product), null, 2) + '\n',
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
  if (process.platform === 'win32') {
    // Compile the actual formal entry with contract fixtures, without signing or
    // executing the fixture NSIS. Match Qualification's PowerShell 7 invocation.
    const output = join(root, 'formal installer output');
    execFileSync(
      'pwsh.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/web-installer/build.ps1'),
        '-ProductDirectory',
        product,
        '-CoreDirectory',
        core,
        '-OutputDirectory',
        output,
        '-Qualification',
      ],
      {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: context.repository,
          GITHUB_REF: context.ref,
          GITHUB_SHA: context.sha,
          GITHUB_EVENT_NAME: context.event,
          GITHUB_WORKFLOW_REF: context.workflowRef,
          QUALIFICATION_SOURCE_INPUT: context.sha,
        },
      },
    );
    const build = JSON.parse(await readFile(join(output, 'web-installer-build.json'), 'utf8'));
    const entry = await readFile(join(output, `Mizar-v${version}-Windows-x64-WebInstaller.exe`));
    expect(entry.subarray(0, 2).toString()).toBe('MZ');
    expect(build).toMatchObject({
      artifact: `Mizar-v${version}-Windows-x64-WebInstaller.exe`,
      bytes: entry.length,
      sha256: sha(entry),
      gitSha: context.sha,
      version,
      published: false,
      core: plan.coreName,
      installer: plan.name,
    });
    console.log(`Formal entry compiled from contract fixture: ${entry.length} bytes`);
  }
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
