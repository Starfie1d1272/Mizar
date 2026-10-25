import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareIsolatedPack } from '../src/orchestration/prepare-pack.js';
import { verifyIsolatedPack } from '../src/orchestration/isolated-pack.js';
import { consoleLaunchOptions, MulnxTool } from '../src/orchestration/tool.js';
import { nativeCs2PathSchema } from '../src/orchestration/routes.js';
it('accepts the native extended drive path while refusing UNC, relative paths and other executables', () => {
  const path = 'D:\\Steam\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe';
  expect(nativeCs2PathSchema.parse(path)).toBe(path);
  expect(nativeCs2PathSchema.parse('\\\\?\\' + path)).toBe(path);
  expect(nativeCs2PathSchema.parse(path.replaceAll('\\', '/'))).toBe(path);
  for (const invalid of ['..\\cs2.exe', '\\\\server\\share\\cs2.exe', 'D:\\game\\other.exe'])
    expect(nativeCs2PathSchema.safeParse(invalid).success).toBe(false);
});
it('adds the consented engine log flag while preserving upstream options and environment checks', () => {
  const original =
    'path: old\nlaunchOptions: -insecure -novid\npatternsCheckDangerous:\n  - 完美世界竞技\n';
  expect(consoleLaunchOptions(original)).toBe(
    'path: old\nlaunchOptions: "-insecure -novid -condebug"\npatternsCheckDangerous:\n  - 完美世界竞技\n',
  );
  expect(consoleLaunchOptions(consoleLaunchOptions(original))).toBe(consoleLaunchOptions(original));
  expect(() => consoleLaunchOptions('launchOptions: -insecure\nlaunchOptions: -novid\n')).toThrow();
});
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('prepares the installed launcher locally and preserves upstream options', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mizar-mulnx-offline-')));
  roots.push(root);
  const directory = `release-${'a'.repeat(64)}-11111111-1111-4111-8111-111111111111`;
  const injector = join(root, directory, 'MulNX/CS2Injector');
  await mkdir(join(injector, 'CS2BootLoader/Config'), { recursive: true });
  await writeFile(join(injector, 'CS2Injector.exe'), 'fixture, never executed');
  await writeFile(join(injector, 'launch-protocol.txt'), '1');
  await writeFile(
    join(injector, 'CS2BootLoader/Config/config.yaml'),
    'path: old\nlaunchOptions: -insecure -novid\npatternsCheckDangerous:\n  - 完美世界竞技\n',
  );
  await writeFile(
    join(root, 'current.json'),
    JSON.stringify({
      directory,
      packs: [],
      release: {
        id: 1,
        assetId: 2,
        tag: 'BetaFixture',
        publishedAt: '2026-10-23T08:54:04Z',
        url: 'https://github.com/Co1Swet/MulNX_CS2/releases/download/BetaFixture/MulNX.7z',
        size: 1,
        sha256: 'a'.repeat(64),
      },
    }),
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
  const diagnostics: unknown[] = [];
  const tool = new MulnxTool(root, join(root, 'bundle'), (stage, evidence) =>
    diagnostics.push({ stage, evidence }),
  );
  await tool.load();
  const prepared = await tool.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', true);
  expect(prepared).toMatchObject({ version: 'BetaFixture', launchProtocol: 1 });
  expect(await readFile(join(injector, 'CS2BootLoader/Config/config.yaml'), 'utf8')).toContain(
    'patternsCheckDangerous:\n  - 完美世界竞技',
  );
  expect(tool.view()).toMatchObject({ launchProtocol: 1 });
  const config = join(injector, 'CS2BootLoader/Config/config.yaml');
  expect(await readFile(config, 'utf8')).toContain('-condebug');
  // A process restart must retain ownership, so disabling removes only our flag.
  const restarted = new MulnxTool(root, join(root, 'bundle'));
  await restarted.load();
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false);
  expect(await readFile(config, 'utf8')).toContain('launchOptions: -insecure -novid\n');
  // User supplied condebug is retained after either preference change.
  await writeFile(config, 'path: old\nlaunchOptions: "-insecure -condebug -novid"\n');
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', true);
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false);
  expect(await readFile(config, 'utf8')).toContain('-insecure -condebug -novid');
  await writeFile(config, 'path: old\nlaunchOptions: -insecure\n');
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', true);
  const owned = await readFile(config, 'utf8');
  await writeFile(config, owned.replace('-condebug', '-condebug -user-option'));
  await expect(restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false)).rejects.toThrow(
    'mulnx_console_ownership_conflict',
  );
  expect(await readFile(config, 'utf8')).toContain('-user-option');
  // Older and future unknown markers remain unsupported, without network upgrade.
  await rm(join(injector, 'launch-protocol.txt'));
  const legacy = new MulnxTool(root, join(root, 'bundle'));
  await legacy.load();
  expect(legacy.view().launchProtocol).toBeNull();
  await writeFile(config, owned);
  expect(await legacy.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false)).toMatchObject({
    launchProtocol: null,
  });
  await writeFile(join(injector, 'launch-protocol.txt'), '2');
  expect(await legacy.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false)).toMatchObject({
    launchProtocol: null,
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(tool.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, true)).rejects.toThrow();
  expect(fetch).toHaveBeenCalled();
  expect(tool.view().installed).toBe('BetaFixture');
  expect(diagnostics).toContainEqual(expect.objectContaining({ stage: 'mulnx_prepare' }));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-isolation-'));
  roots.push(root);
  const source = join(root, 'Mtp');
  await mkdir(join(source, 'CamMacros'), { recursive: true });
  await mkdir(join(source, 'Campaths'));
  const original = 'name: Mtp\nOnNewRound:\n  - begin\n';
  await writeFile(join(source, 'Mtp.yaml'), original);
  await writeFile(join(source, 'CamMacros', 'begin.yaml'), 'name: begin\n');
  return { root, source, original };
}
it('copies user resources into a unique pack with no automatic lists and leaves the original intact', async () => {
  const { root, source, original } = await fixture();
  expect(verifyIsolatedPack(root, 'Mtp')).toBe(false);
  const pack = await prepareIsolatedPack(source, root);
  expect(verifyIsolatedPack(root, pack.name)).toBe(true);
  expect(await readFile(join(source, 'Mtp.yaml'), 'utf8')).toBe(original);
  expect(await readFile(join(root, pack.name, 'CamMacros', 'begin.yaml'), 'utf8')).toBe(
    'name: begin\n',
  );
  const path = join(root, pack.name, `${pack.name}.yaml`);
  const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    name: pack.name,
    KCP: { usable: false },
    OnNewRound: [],
    OnRoundStart: [],
    OnRoundEnd: [],
  });
  metadata.OnNewRound = ['begin'];
  await writeFile(path, JSON.stringify(metadata));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  expect(verifyIsolatedPack(undefined, pack.name)).toBe(false);
  expect(verifyIsolatedPack(root, '../Mtp')).toBe(false);
});
it('rejects linked resources and never seals a failed copy', async () => {
  const { root, source } = await fixture();
  // Windows hardlinks exercise the same no-alias boundary without requiring symlink privileges.
  const createLink = process.platform === 'win32' ? link : symlink;
  await createLink(join(source, 'Mtp.yaml'), join(source, 'CamMacros', 'link.yaml'));
  await expect(prepareIsolatedPack(source, root)).rejects.toThrow('pack_unsafe_entry');
});
