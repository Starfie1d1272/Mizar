import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  allocateContentHashedOutputPath,
  importCs2Assets,
  parseArgs,
  parseCliVersion,
  recoverInterruptedTransaction,
  replaceDirectoryTransactionally,
  versionMatches,
} from './import.mjs';
import { readJson } from './common.mjs';

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createTempDir(prefix = 'rivalhub-cs2-import-test-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

async function createFakeCli(directory, { defaultVersion } = {}) {
  const cliScriptPath = join(directory, 'fake-source2viewer-cli.mjs');
  const logPath = join(directory, 'fake-cli-invocations.json');

  await writeFile(logPath, '[]', 'utf8');

  const versionLiteral = JSON.stringify(defaultVersion ?? '20.0.0');
  const base64Svg = Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>\r\n  <path d='M0 0h32v32H0z'/>\r\n</svg>   \r\n\r\n",
  ).toString('base64');
  const scriptContent = [
    '#!/usr/bin/env node',
    'import { Buffer } from "node:buffer";',
    'import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    '',
    'const args = process.argv.slice(2);',
    'const logPath = process.env.FAKE_VRF_LOG_PATH;',
    'if (logPath) {',
    '  const logs = JSON.parse(readFileSync(logPath, "utf8") || "[]");',
    '  logs.push({ args, env: { failOnDecompile: process.env.FAKE_VRF_FAIL_ON_DECOMPILE } });',
    '  writeFileSync(logPath, JSON.stringify(logs, null, 2), "utf8");',
    '}',
    '',
    'if (args.includes("--version")) {',
    '  const version = process.env.FAKE_VRF_VERSION || ' + versionLiteral + ';',
    '  process.stdout.write("Source2Viewer " + version + String.fromCharCode(10));',
    '  process.exit(0);',
    '}',
    '',
    'const fIndex = args.indexOf("-f");',
    'const oIndex = args.indexOf("-o");',
    'const dIndex = args.indexOf("-d");',
    'if (fIndex !== -1 && oIndex !== -1 && dIndex === -1) {',
    '  const sourcePath = args[fIndex + 1];',
    '  const outDir = args[oIndex + 1];',
    '  const targetRawFile = join(outDir, sourcePath);',
    '  mkdirSync(dirname(targetRawFile), { recursive: true });',
    '  const mockBytes = Buffer.from("MOCK_VSVG_C_COMPILED_BYTES_FOR:" + sourcePath + String.fromCharCode(10), "utf8");',
    '  writeFileSync(targetRawFile, mockBytes);',
    '  process.exit(0);',
    '}',
    '',
    'if (dIndex !== -1) {',
    '  if (process.env.FAKE_VRF_FAIL_ON_DECOMPILE === "1") {',
    '    process.stderr.write("Simulated VRF decompile failure" + String.fromCharCode(10));',
    '    process.exit(2);',
    '  }',
    '  const iIndex = args.indexOf("-i");',
    '  const rawPath = args[iIndex + 1];',
    '  const svgPath = args[oIndex + 1];',
    '  mkdirSync(dirname(svgPath), { recursive: true });',
    '  const bom = Buffer.from([0xef, 0xbb, 0xbf]);',
    '  const body = Buffer.from(' + JSON.stringify(base64Svg) + ', "base64");',
    '  writeFileSync(svgPath, Buffer.concat([bom, body]));',
    '  process.exit(0);',
    '}',
    '',
    'process.stderr.write("Unknown fake CLI arguments: " + args.join(" ") + String.fromCharCode(10));',
    'process.exit(1);',
  ].join('\n');

  await writeFile(cliScriptPath, scriptContent, 'utf8');
  await chmod(cliScriptPath, 0o755);

  // Use the process.execPath launcher seam directly on all platforms with shell: false
  const launcher = { command: process.execPath, prefixArgs: [cliScriptPath] };
  return { cliExecutable: cliScriptPath, cliScriptPath, launcher, logPath };
}

async function createFixtureRepo(root, { customToolchain, customCatalog } = {}) {
  const repositoryRoot = root;
  const packageRoot = join(repositoryRoot, 'packages', 'cs2-assets');
  const scriptsRoot = join(repositoryRoot, 'scripts', 'cs2-assets');
  const targetOutputRoot = join(packageRoot, 'generated');

  await mkdir(join(packageRoot, 'catalog'), { recursive: true });
  await mkdir(targetOutputRoot, { recursive: true });
  await mkdir(scriptsRoot, { recursive: true });

  const toolchain = customToolchain ?? {
    valveResourceFormat: {
      project: 'ValveResourceFormat',
      tool: 'Source2Viewer-CLI',
      version: '20.0.6980+a06886f7d06049052d32a7381ec05523064a2ca0',
    },
  };
  await writeFile(
    join(scriptsRoot, 'toolchain.json'),
    `${JSON.stringify(toolchain, null, 2)}\n`,
    'utf8',
  );

  const catalog = customCatalog ?? {
    schemaVersion: 1,
    items: [
      {
        canonicalKey: 'utility.flashbang',
        gsiWeaponNames: ['weapon_flashbang'],
        sourcePath: 'panorama/images/icons/equipment/flashbang.vsvg_c',
        kind: 'utility',
        family: 'grenade',
        displayCategory: 'utility',
        assetId: 'utility.flashbang',
        ammoPresentation: 'utility',
        tintMode: 'mask',
        aliases: [],
        evidence: [{ kind: 'live-gsi', reference: 'fixture' }],
      },
      {
        canonicalKey: 'weapon.ak47',
        gsiWeaponNames: ['weapon_ak47'],
        sourcePath: 'panorama/images/icons/equipment/ak47.vsvg_c',
        kind: 'firearm',
        family: 'rifle',
        displayCategory: 'rifle',
        assetId: 'weapon.ak47',
        ammoPresentation: 'magazine',
        tintMode: 'mask',
        aliases: [],
        evidence: [{ kind: 'live-gsi', reference: 'fixture' }],
      },
    ],
  };
  await writeFile(
    join(packageRoot, 'catalog', 'items.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );

  return { repositoryRoot, packageRoot, scriptsRoot, targetOutputRoot, toolchain, catalog };
}

describe('cs2-assets import arguments', () => {
  it('requires an explicit build id for direct VPK input', () => {
    expect(() => parseArgs(['--vpk', '/tmp/pak01_dir.vpk'])).toThrow(
      '--vpk 模式必须显式提供 --steam-build-id',
    );
  });

  it('accepts VPK input with an explicit build id and CLI path', () => {
    expect(
      parseArgs([
        '--vpk',
        '/tmp/pak01_dir.vpk',
        '--steam-build-id',
        '123456',
        '--cli',
        '/tmp/Source2Viewer-CLI',
      ]),
    ).toEqual({
      vpk: resolve('/tmp/pak01_dir.vpk'),
      steamBuildId: '123456',
      cli: resolve('/tmp/Source2Viewer-CLI'),
    });
  });

  it('accepts the pnpm argument separator', () => {
    expect(parseArgs(['--', '--vpk', '/tmp/pak01_dir.vpk', '--steam-build-id', '123456'])).toEqual({
      vpk: resolve('/tmp/pak01_dir.vpk'),
      steamBuildId: '123456',
    });
  });
});

describe('cs2-assets version matching & parsing contract', () => {
  const expected = '20.0.6980+a06886f7d06049052d32a7381ec05523064a2ca0';

  it('strictly parses Version: header and matches exact string', () => {
    expect(parseCliVersion(`Version: ${expected}\nOS: Windows`)).toBe(expected);
    expect(versionMatches(`Version: ${expected}\nOS: Windows`, expected)).toBe(true);
    expect(versionMatches(`Source2Viewer ${expected}\n`, expected)).toBe(true);
    expect(versionMatches(expected, expected)).toBe(true);
  });

  it('rejects version strings with dirty suffix or surrounding characters', () => {
    // -dirty suffix must be rejected
    expect(versionMatches(`Version: ${expected}-dirty\nOS: Windows`, expected)).toBe(false);
    expect(versionMatches(`Source2Viewer ${expected}-dirty`, expected)).toBe(false);

    // Surrounding characters must be rejected
    expect(versionMatches(`Version: X${expected}Y`, expected)).toBe(false);
    expect(versionMatches(`${expected}.1`, expected)).toBe(false);
    expect(versionMatches('20.0.6980', expected)).toBe(false);
  });
});

describe('cs2-assets import E2E with fake Source2Viewer-CLI', () => {
  it('A. accepts pinned toolchain version and fails fast on wrong version before touching target', async () => {
    const root = await createTempDir();
    const fixture = await createFixtureRepo(root);

    // Create target initial sentinel file
    const sentinelFile = join(fixture.targetOutputRoot, 'sentinel.txt');
    await writeFile(sentinelFile, 'initial-target-state\n', 'utf8');

    // Test wrong version fails fast
    const { cliExecutable: wrongCli, launcher: wrongLauncher } = await createFakeCli(root, {
      defaultVersion: '19.9.9-unsupported',
    });
    const fakeVpk = join(root, 'pak01_dir.vpk');
    await writeFile(fakeVpk, 'dummy-vpk', 'utf8');

    await expect(
      importCs2Assets({
        options: {
          vpk: fakeVpk,
          steamBuildId: '987654',
          cli: wrongCli,
          _launcher: wrongLauncher,
        },
        repositoryRoot: fixture.repositoryRoot,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('Source2Viewer-CLI 版本不匹配');

    // Target must NOT have been modified
    expect(await readFile(sentinelFile, 'utf8')).toBe('initial-target-state\n');
  });

  it('B. supports CS2-root input mode and only extracts catalog-declared allowlisted .vsvg_c paths', async () => {
    const root = await createTempDir();
    const fixture = await createFixtureRepo(root);
    const pinnedVersion = fixture.toolchain.valveResourceFormat.version;
    const { cliExecutable, launcher, logPath } = await createFakeCli(root, {
      defaultVersion: pinnedVersion,
    });

    const steamappsDir = join(root, 'steamapps');
    const cs2Root = join(steamappsDir, 'common', 'Counter-Strike Global Offensive');
    const vpkDir = join(cs2Root, 'game', 'csgo');
    await mkdir(vpkDir, { recursive: true });
    await writeFile(join(vpkDir, 'pak01_dir.vpk'), 'dummy-vpk-bytes', 'utf8');
    await writeFile(
      join(steamappsDir, 'appmanifest_730.acf'),
      '"AppState"\n{\n\t"appid"\t"730"\n\t"buildid"\t"25218825"\n}\n',
      'utf8',
    );

    const prevLogEnv = process.env.FAKE_VRF_LOG_PATH;
    process.env.FAKE_VRF_LOG_PATH = logPath;

    try {
      const result = await importCs2Assets({
        options: {
          cs2Root,
          cli: cliExecutable,
          _launcher: launcher,
        },
        repositoryRoot: fixture.repositoryRoot,
        packageRoot: fixture.packageRoot,
      });

      expect(result.assets).toBe(2);
      expect(result.input.steamBuildId).toBe('25218825');

      const logs = await readJson(logPath);
      // Invocations should only be: 1 version check + 2 resource extractions (-f) + 2 decompiles (-d)
      const extractInvocations = logs.filter((l) => l.args.includes('-f'));
      expect(extractInvocations).toHaveLength(2);

      const extractedFiles = extractInvocations.map((l) => l.args[l.args.indexOf('-f') + 1]);
      expect(extractedFiles).toEqual([
        'panorama/images/icons/equipment/flashbang.vsvg_c',
        'panorama/images/icons/equipment/ak47.vsvg_c',
      ]);
      // Verify no broad extraction without -f
      expect(logs.some((l) => l.args.includes('-e') && !l.args.includes('-f'))).toBe(false);
    } finally {
      if (prevLogEnv !== undefined) process.env.FAKE_VRF_LOG_PATH = prevLogEnv;
      else delete process.env.FAKE_VRF_LOG_PATH;
    }
  });

  it('C. verifies hashing and normalization: strips BOM, normalizes CRLF, hashes content into filename', async () => {
    const root = await createTempDir();
    const fixture = await createFixtureRepo(root);
    const pinnedVersion = fixture.toolchain.valveResourceFormat.version;
    const { cliExecutable, launcher } = await createFakeCli(root, {
      defaultVersion: pinnedVersion,
    });

    const fakeVpk = join(root, 'pak01_dir.vpk');
    await writeFile(fakeVpk, 'dummy-vpk', 'utf8');

    await importCs2Assets({
      options: {
        vpk: fakeVpk,
        steamBuildId: '25218825',
        cli: cliExecutable,
        _launcher: launcher,
      },
      repositoryRoot: fixture.repositoryRoot,
      packageRoot: fixture.packageRoot,
    });

    const manifest = await readJson(join(fixture.targetOutputRoot, 'manifest.json'));
    const ak47Asset = manifest.assets['weapon.ak47'];
    expect(ak47Asset).toBeDefined();

    // Verify raw sourceSha256 matches the raw bytes emitted by fake CLI
    const expectedRawSourceBytes = Buffer.from(
      'MOCK_VSVG_C_COMPILED_BYTES_FOR:panorama/images/icons/equipment/ak47.vsvg_c\n',
      'utf8',
    );
    const expectedSourceHash = createHash('sha256').update(expectedRawSourceBytes).digest('hex');
    expect(ak47Asset.sourceSha256).toBe(expectedSourceHash);

    // Verify output SVG content: BOM stripped, CRLF replaced with LF, trailing newline present
    const diskSvgPath = join(fixture.targetOutputRoot, 'public', ak47Asset.outputPath.slice(1));
    const svgBytes = await readFile(diskSvgPath);
    const svgText = svgBytes.toString('utf8');

    expect(svgText.startsWith('<svg')).toBe(true);
    expect(svgText.includes('\r\n')).toBe(false);
    expect(svgText.endsWith('\n')).toBe(true);
    expect(svgText.startsWith('\uFEFF')).toBe(false);

    // Output hash matches file on disk
    const expectedOutputSha256 = createHash('sha256').update(svgBytes).digest('hex');
    expect(ak47Asset.outputSha256).toBe(expectedOutputSha256);

    // Output filename embeds first 12 characters of outputSha256
    expect(ak47Asset.outputPath).toContain(`.${expectedOutputSha256.slice(0, 12)}.`);
  });

  it('D. guarantees determinism: identical inputs produce identical manifest, paths, and SVGs without wall-clock noise', async () => {
    const root = await createTempDir();
    const fixture = await createFixtureRepo(root);
    const pinnedVersion = fixture.toolchain.valveResourceFormat.version;
    const { cliExecutable, launcher } = await createFakeCli(root, {
      defaultVersion: pinnedVersion,
    });

    const fakeVpk = join(root, 'pak01_dir.vpk');
    await writeFile(fakeVpk, 'dummy-vpk', 'utf8');

    const output1 = join(root, 'output1');
    const output2 = join(root, 'output2');

    await importCs2Assets({
      options: {
        vpk: fakeVpk,
        steamBuildId: '25218825',
        cli: cliExecutable,
        _launcher: launcher,
        output: output1,
      },
      repositoryRoot: fixture.repositoryRoot,
      packageRoot: fixture.packageRoot,
    });

    await importCs2Assets({
      options: {
        vpk: fakeVpk,
        steamBuildId: '25218825',
        cli: cliExecutable,
        _launcher: launcher,
        output: output2,
      },
      repositoryRoot: fixture.repositoryRoot,
      packageRoot: fixture.packageRoot,
    });

    const manifest1 = await readFile(join(output1, 'manifest.json'), 'utf8');
    const manifest2 = await readFile(join(output2, 'manifest.json'), 'utf8');
    expect(manifest1).toBe(manifest2);

    const publicManifest1 = await readFile(
      join(output1, 'public', 'assets', 'cs2', 'manifest.json'),
      'utf8',
    );
    const publicManifest2 = await readFile(
      join(output2, 'public', 'assets', 'cs2', 'manifest.json'),
      'utf8',
    );
    expect(publicManifest1).toBe(publicManifest2);
    expect(manifest1).toBe(publicManifest1);

    // No wall-clock noise like generatedAt
    expect(manifest1.includes('generatedAt')).toBe(false);
    expect(manifest1.includes('timestamp')).toBe(false);
  });

  it('E. replaces the generated tree, cleans stale orphans, and preserves target on pre-swap failure', async () => {
    const root = await createTempDir();
    const fixture = await createFixtureRepo(root);
    const pinnedVersion = fixture.toolchain.valveResourceFormat.version;
    const { cliExecutable, launcher } = await createFakeCli(root, {
      defaultVersion: pinnedVersion,
    });

    const fakeVpk = join(root, 'pak01_dir.vpk');
    await writeFile(fakeVpk, 'dummy-vpk', 'utf8');

    // Pre-populate targetOutputRoot with an orphan asset and an old manifest
    const orphanSvgPath = join(
      fixture.targetOutputRoot,
      'public',
      'assets',
      'cs2',
      'weapon',
      'old-orphan.111111111111.svg',
    );
    await mkdir(dirname(orphanSvgPath), { recursive: true });
    await writeFile(orphanSvgPath, '<svg id="orphan"/>\n', 'utf8');
    const oldManifestPath = join(fixture.targetOutputRoot, 'manifest.json');
    await writeFile(oldManifestPath, '{"old": true}\n', 'utf8');

    // Successful run should atomically replace target and wipe out old-orphan.svg
    await importCs2Assets({
      options: { vpk: fakeVpk, steamBuildId: '25218825', cli: cliExecutable, _launcher: launcher },
      repositoryRoot: fixture.repositoryRoot,
      packageRoot: fixture.packageRoot,
    });

    // Check old orphan is gone
    let orphanExists = true;
    try {
      await readFile(orphanSvgPath);
    } catch {
      orphanExists = false;
    }
    expect(orphanExists).toBe(false);

    // Now test midway failure: pre-populate a sentinel and set fail-on-decompile
    const preservedSentinel = join(fixture.targetOutputRoot, 'preserved-manifest-checkpoint.txt');
    await writeFile(preservedSentinel, 'checkpoint-data\n', 'utf8');

    const prevFailEnv = process.env.FAKE_VRF_FAIL_ON_DECOMPILE;
    process.env.FAKE_VRF_FAIL_ON_DECOMPILE = '1';

    try {
      await expect(
        importCs2Assets({
          options: {
            vpk: fakeVpk,
            steamBuildId: '25218825',
            cli: cliExecutable,
            _launcher: launcher,
          },
          repositoryRoot: fixture.repositoryRoot,
          packageRoot: fixture.packageRoot,
        }),
      ).rejects.toThrow('Simulated VRF decompile failure');

      // The previous directory must be intact and preserved!
      expect(await readFile(preservedSentinel, 'utf8')).toBe('checkpoint-data\n');
    } finally {
      if (prevFailEnv !== undefined) process.env.FAKE_VRF_FAIL_ON_DECOMPILE = prevFailEnv;
      else delete process.env.FAKE_VRF_FAIL_ON_DECOMPILE;
    }
  });

  it('F. verifies staging tree before swap: verifier failure leaves the existing target untouched', async () => {
    const root = await createTempDir();
    const collisionCatalog = {
      schemaVersion: 1,
      items: [
        {
          canonicalKey: 'collision.ak47',
          gsiWeaponNames: ['weapon_collision_ak47'],
          sourcePath: 'panorama/images/icons/equipment/knife.vsvg_c',
          kind: 'melee',
          family: 'melee',
          displayCategory: 'melee',
          assetId: 'melee.ak47',
          ammoPresentation: 'none',
          tintMode: 'mask',
          aliases: [],
          evidence: [{ kind: 'official-game-data', reference: 'fixture collision' }],
        },
        {
          canonicalKey: 'weapon.ak47',
          gsiWeaponNames: ['weapon_ak47'],
          sourcePath: 'panorama/images/icons/equipment/ak47.vsvg_c',
          kind: 'firearm',
          family: 'rifle',
          displayCategory: 'rifle',
          assetId: 'weapon.ak47',
          ammoPresentation: 'magazine',
          tintMode: 'mask',
          aliases: [],
          evidence: [{ kind: 'official-game-data', reference: 'fixture collision' }],
        },
      ],
    };
    const fixture = await createFixtureRepo(root, { customCatalog: collisionCatalog });
    const pinnedVersion = fixture.toolchain.valveResourceFormat.version;
    const { cliExecutable, launcher } = await createFakeCli(root, {
      defaultVersion: pinnedVersion,
    });

    const targetSentinel = join(fixture.targetOutputRoot, 'target-sentinel.txt');
    await writeFile(targetSentinel, 'original-target-unmodified\n', 'utf8');

    const fakeVpk = join(root, 'pak01_dir.vpk');
    await writeFile(fakeVpk, 'dummy-vpk', 'utf8');

    // The fake CLI emits identical SVG bytes for both items. Because firearm and melee
    // both publish under /weapon and both assetIds have the same slug, staging produces
    // duplicate outputPath values that only the full verifier rejects.
    await expect(
      importCs2Assets({
        options: {
          vpk: fakeVpk,
          steamBuildId: '25218825',
          cli: cliExecutable,
          _launcher: launcher,
        },
        repositoryRoot: fixture.repositoryRoot,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow();

    expect(await readFile(targetSentinel, 'utf8')).toBe('original-target-unmodified\n');
  });

  it('G. records comprehensive provenance without leaking machine absolute paths', async () => {
    const root = await createTempDir();
    const fixture = await createFixtureRepo(root);
    const pinnedVersion = fixture.toolchain.valveResourceFormat.version;
    const { cliExecutable, launcher } = await createFakeCli(root, {
      defaultVersion: pinnedVersion,
    });

    const fakeVpk = join(root, 'pak01_dir.vpk');
    await writeFile(fakeVpk, 'dummy-vpk', 'utf8');

    await importCs2Assets({
      options: { vpk: fakeVpk, steamBuildId: '25218825', cli: cliExecutable, _launcher: launcher },
      repositoryRoot: fixture.repositoryRoot,
      packageRoot: fixture.packageRoot,
    });

    const manifestRaw = await readFile(join(fixture.targetOutputRoot, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.source).toEqual({
      appId: 730,
      steamBuildId: '25218825',
      container: 'game/csgo/pak01_dir.vpk',
    });
    expect(manifest.extractor).toEqual({
      project: 'ValveResourceFormat',
      tool: 'Source2Viewer-CLI',
      version: pinnedVersion,
    });

    // Check no machine absolute paths in JSON
    expect(manifestRaw.includes(root)).toBe(false);
    expect(manifestRaw.includes('/Users/')).toBe(false);
    expect(manifestRaw.includes('C:\\')).toBe(false);
    expect(manifestRaw.includes('\\\\')).toBe(false);

    // All sourcePath and outputPath are relative POSIX paths
    for (const asset of Object.values(manifest.assets)) {
      expect(asset.sourcePath.startsWith('panorama/')).toBe(true);
      expect(asset.outputPath.startsWith('/assets/cs2/')).toBe(true);
      expect(asset.mediaType).toBe('image/svg+xml');
    }
  });
});
describe('allocateContentHashedOutputPath collision expansion contract', () => {
  const dummyItem = { kind: 'firearm', assetId: 'weapon.ak47' };

  it('expands from 12 to 16 hex when a fabricated prefix collision occurs', () => {
    const occupied = new Map();
    const hash1 = 'aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111';
    const hash2 = 'aaaaaaaaaaaa2222222222222222222222222222222222222222222222222222';

    const path1 = allocateContentHashedOutputPath({
      item: dummyItem,
      outputSha256: hash1,
      occupiedPaths: occupied,
    });
    expect(path1).toBe('/assets/cs2/weapon/ak47.aaaaaaaaaaaa.svg');

    // Second asset with identical 12-hex prefix but different content expands to 16 hex
    const path2 = allocateContentHashedOutputPath({
      item: dummyItem,
      outputSha256: hash2,
      occupiedPaths: occupied,
    });
    expect(path2).toBe('/assets/cs2/weapon/ak47.aaaaaaaaaaaa2222.svg');
  });

  it('throws explicit error on unresolvable route collision even at full 64 hex', () => {
    const occupied = new Map();
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const item1 = { kind: 'firearm', assetId: 'weapon.knife' };
    const item2 = { kind: 'melee', assetId: 'melee.knife' }; // identical category 'weapon' and slug 'knife', different assetIds

    allocateContentHashedOutputPath({
      item: item1,
      outputSha256: hash,
      occupiedPaths: occupied,
    });

    expect(() =>
      allocateContentHashedOutputPath({
        item: item2,
        outputSha256: hash,
        occupiedPaths: occupied,
      }),
    ).toThrow(/CS2 asset output route collision/);
  });
});

describe('replaceDirectoryTransactionally & recoverInterruptedTransaction', () => {
  it('Case 1: second rename fails, rollback succeeds -> target restored, backup cleaned, rejects original error', async () => {
    const root = await createTempDir();
    const targetDir = join(root, 'target');
    const stagingDir = join(root, 'staging');
    const backupDir = `${targetDir}.previous`;

    await mkdir(targetDir);
    await writeFile(join(targetDir, 'sentinel.txt'), 'old-target-state', 'utf8');

    await mkdir(stagingDir);
    await writeFile(join(stagingDir, 'sentinel.txt'), 'new-staging-state', 'utf8');

    // Injected fileOps: fail when moving staging -> target
    const mockFileOps = {
      rename: async (from, to) => {
        if (from === stagingDir && to === targetDir) {
          throw new Error('Injected failure during staging -> target');
        }
        return rename(from, to);
      },
      rm,
      access,
    };

    await expect(
      replaceDirectoryTransactionally(stagingDir, targetDir, mockFileOps),
    ).rejects.toThrow('Injected failure during staging -> target');

    // Target must be restored to old state
    expect(await readFile(join(targetDir, 'sentinel.txt'), 'utf8')).toBe('old-target-state');
    // Staging content must not have become target
    expect(await readFile(join(stagingDir, 'sentinel.txt'), 'utf8')).toBe('new-staging-state');
    // Backup must not linger
    await expect(access(backupDir)).rejects.toThrow();
  });

  it('Case 2: replacement fails and rollback itself fails -> throws AggregateError, backup tree preserved', async () => {
    const root = await createTempDir();
    const targetDir = join(root, 'target');
    const stagingDir = join(root, 'staging');
    const backupDir = `${targetDir}.previous`;

    await mkdir(targetDir);
    await writeFile(join(targetDir, 'sentinel.txt'), 'old-target-state', 'utf8');

    await mkdir(stagingDir);
    await writeFile(join(stagingDir, 'sentinel.txt'), 'new-staging-state', 'utf8');

    // Injected fileOps: fail both staging -> target AND backup -> target
    const mockFileOps = {
      rename: async (from, to) => {
        if (from === stagingDir && to === targetDir) {
          throw new Error('Injected replacement error');
        }
        if (from === backupDir && to === targetDir) {
          throw new Error('Injected rollback error');
        }
        return rename(from, to);
      },
      rm,
      access,
    };

    let caughtError;
    try {
      await replaceDirectoryTransactionally(stagingDir, targetDir, mockFileOps);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    expect(caughtError.message).toContain('previous tree remains at');
    expect(caughtError.message).toContain(backupDir);
    expect(caughtError.errors).toHaveLength(2);
    expect(caughtError.errors[0].message).toBe('Injected replacement error');
    expect(caughtError.errors[1].message).toBe('Injected rollback error');

    // Crucial: backup tree must NOT have been removed so maintainers can recover
    expect(await readFile(join(backupDir, 'sentinel.txt'), 'utf8')).toBe('old-target-state');
  });

  it('Case 3: simulated interrupted previous run (target absent, backup exists) -> recovered to target', async () => {
    const root = await createTempDir();
    const targetDir = join(root, 'target');
    const backupDir = `${targetDir}.previous`;

    // Simulate crash after target -> backup: target is missing, backup has data
    await mkdir(backupDir);
    await writeFile(join(backupDir, 'sentinel.txt'), 'interrupted-state', 'utf8');

    await recoverInterruptedTransaction(targetDir);

    // Target should be restored from backup
    expect(await readFile(join(targetDir, 'sentinel.txt'), 'utf8')).toBe('interrupted-state');
    await expect(access(backupDir)).rejects.toThrow();
  });

  it('Case 4: simulated completed swap but stale backup (target exists, backup exists) -> stale backup cleaned, target preserved', async () => {
    const root = await createTempDir();
    const targetDir = join(root, 'target');
    const backupDir = `${targetDir}.previous`;

    // Simulate crash before backup cleanup: target has new data, backup has stale data
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'sentinel.txt'), 'target-data', 'utf8');
    await mkdir(backupDir);
    await writeFile(join(backupDir, 'sentinel.txt'), 'stale-backup-data', 'utf8');

    await recoverInterruptedTransaction(targetDir);

    // Target preserved
    expect(await readFile(join(targetDir, 'sentinel.txt'), 'utf8')).toBe('target-data');
    // Stale backup cleaned
    await expect(access(backupDir)).rejects.toThrow();
  });
});
