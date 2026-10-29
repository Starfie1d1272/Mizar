import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareIsolatedPack } from '../src/orchestration/prepare-pack.js';
import { verifyIsolatedPack } from '../src/orchestration/isolated-pack.js';
import { consoleLaunchOptions, firstDemoOptions, MulnxTool } from '../src/orchestration/tool.js';
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
it('removes the bundled first Demo POV trigger without changing other commands', () => {
  const source = 'MulNX/CSCfg/POV\r\n// keep\r\nMulNX/Glow/Enable\r\n';
  expect(firstDemoOptions(source)).toBe(
    '// Mizar: POV remains operator controlled\r\n// keep\r\nMulNX/Glow/Enable\r\n',
  );
  expect(firstDemoOptions(firstDemoOptions(source))).toBe(firstDemoOptions(source));
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
  const uiConfig = join(root, directory, 'MulNX/Config/CS2OBTool_Refl.yaml');
  const injectorConfig = join(root, directory, 'MulNX/Config/CS2Injector_Refl.yaml');
  const firstDemo = join(root, directory, 'MulNX/CS2OBTool/AutoCfgLoad/FirstPlayDemo/first.cfg');
  await mkdir(join(root, directory, 'MulNX/Config'), { recursive: true });
  await mkdir(join(root, directory, 'MulNX/CS2OBTool/AutoCfgLoad/FirstPlayDemo'), {
    recursive: true,
  });
  await writeFile(uiConfig, 'UISystem.ifDrawMid: true\nGlowController.disableGlow: false\n');
  await writeFile(injectorConfig, 'CS2HelperController.injectReshade: true\nOther: true\n');
  await writeFile(firstDemo, 'MulNX/CSCfg/POV\nother\n');
  await mkdir(join(injector, 'CS2BootLoader/Config'), { recursive: true });
  await writeFile(join(injector, 'CS2Injector.exe'), 'fixture, never executed');
  await writeFile(join(injector, 'CS2BootLoader/Config/auto.yaml'), 'autoLaunch: false');
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
  expect(prepared).toMatchObject({ version: 'BetaFixture' });
  expect(await readFile(uiConfig, 'utf8')).toContain('UISystem.ifDrawMid: false');
  expect(await readFile(uiConfig, 'utf8')).toContain('GlowController.disableGlow: false');
  expect(await readFile(injectorConfig, 'utf8')).toContain(
    'CS2HelperController.injectReshade: false',
  );
  expect(await readFile(injectorConfig, 'utf8')).toContain('Other: true');
  expect(await readFile(firstDemo, 'utf8')).toBe(
    '// Mizar: POV remains operator controlled\nother\n',
  );
  expect(await readFile(join(injector, 'CS2BootLoader/Config/config.yaml'), 'utf8')).toContain(
    'patternsCheckDangerous:\n  - 完美世界竞技',
  );
  const config = join(injector, 'CS2BootLoader/Config/config.yaml');
  expect(await readFile(config, 'utf8')).toContain('-condebug');
  const demoCfg = 'mizar_demo_00000000-0000-4000-8000-000000000001.cfg';
  await tool.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', true, false, true, demoCfg);
  expect(await readFile(config, 'utf8')).toContain(`+exec ${demoCfg}`);
  // A process restart must retain ownership, so disabling removes only our flag.
  const restarted = new MulnxTool(root, join(root, 'bundle'));
  await restarted.load();
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false);
  expect(await readFile(config, 'utf8')).toContain('launchOptions: -insecure -novid\n');
  expect(await readFile(config, 'utf8')).not.toContain(demoCfg);
  // The fixed CFG and console flag share one ownership record across restarts.
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', true, false, true);
  expect(await readFile(config, 'utf8')).toContain('-condebug +exec mizar_observer.cfg');
  const combined = await readFile(config, 'utf8');
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, false, true);
  expect(await readFile(config, 'utf8')).toContain('+exec mizar_observer.cfg');
  expect(await readFile(config, 'utf8')).not.toContain('-condebug');
  // A crash between journal and configuration rename accepts either known line.
  const ownership = join(root, directory, 'MulNX/mizar-console-options.json');
  const cfgOnly = await readFile(config, 'utf8');
  const originalLine = 'launchOptions: -insecure -novid';
  const oldLine = combined.match(/^launchOptions:.*$/m)![0];
  const nextLine = cfgOnly.match(/^launchOptions:.*$/m)![0];
  await writeFile(
    ownership,
    JSON.stringify({ original: originalLine, managed: nextLine, previous: oldLine }),
  );
  await writeFile(config, combined);
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, false, true);
  expect(await readFile(config, 'utf8')).toContain(nextLine);
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false);
  expect(await readFile(config, 'utf8')).toContain(originalLine);
  // A user-provided exec remains theirs and is not removed.
  await writeFile(config, 'path: old\nlaunchOptions: "-novid +exec mizar_observer.cfg"\n');
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, false, true);
  await restarted.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false);
  expect(await readFile(config, 'utf8')).toContain('+exec mizar_observer.cfg');
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
  expect(fetch).not.toHaveBeenCalled();
  await expect(tool.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, true)).rejects.toThrow();
  expect(fetch).toHaveBeenCalled();
  expect(tool.view().installed).toBe('BetaFixture');
  expect(diagnostics).toContainEqual(expect.objectContaining({ stage: 'mulnx_prepare' }));
  const launcher = join(injector, 'CS2Injector.exe');
  await rm(launcher);
  const missing = new MulnxTool(root, join(root, 'bundle'));
  await missing.load();
  expect(missing.view().installed).toBe('BetaFixture');
  await expect(missing.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe')).rejects.toThrow(
    '启动程序缺失或无法读取',
  );
  const attempts = vi.mocked(fetch).mock.calls.length;
  await expect(
    missing.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, true),
  ).rejects.toThrow('mulnx_metadata_http_403');
  expect(vi.mocked(fetch).mock.calls.length).toBe(attempts + 1);
  expect(await readFile(join(root, 'current.json'), 'utf8')).toContain(directory);
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        {
          id: 1,
          draft: false,
          published_at: '2026-10-23T08:54:04Z',
          tag_name: 'BetaFixture',
          assets: [
            {
              id: 2,
              name: 'MulNX.7z',
              digest: `sha256:${'a'.repeat(64)}`,
              size: 1,
              browser_download_url:
                'https://github.com/Co1Swet/MulNX_CS2/releases/download/BetaFixture/MulNX.7z',
            },
          ],
        },
      ]),
    ),
  );
  const install = vi
    .spyOn(
      missing as unknown as { install: (release: unknown, path: string) => Promise<void> },
      'install',
    )
    .mockImplementation(async () => {
      await writeFile(launcher, 'fixture, reinstalled');
    });
  await writeFile(config, owned);
  await expect(
    missing.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe', false, true),
  ).resolves.toMatchObject({ version: 'BetaFixture' });
  expect(install).toHaveBeenCalledOnce();
  expect(await readFile(join(root, 'current.json'), 'utf8')).toContain(directory);
  install.mockRestore();

  await writeFile(launcher, 'fixture, restored');
  await writeFile(config, owned);
  await expect(missing.prepare('D:\\Steam\\game\\bin\\win64\\cs2.exe')).resolves.toMatchObject({
    version: 'BetaFixture',
  });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-isolation-'));
  roots.push(root);
  const source = join(root, 'Mtp');
  await mkdir(join(source, 'CamMacros'), { recursive: true });
  await mkdir(join(source, 'Campaths'));
  const original = 'name: Mtp\nOnNewRound:\n  - begin\n';
  await writeFile(join(source, 'Mtp.yaml'), original);
  await writeFile(
    join(source, 'CamMacros', 'begin.yaml'),
    'name: begin\nKCP: { usable: true, ctrl: false, shift: false, alt: true, vkCode: 67, comboClick: 2 }\n',
  );
  return { root, source, original };
}
it('copies user resources into a unique pack with no automatic lists and leaves the original intact', async () => {
  const { root, source, original } = await fixture();
  expect(verifyIsolatedPack(root, 'Mtp')).toBe(false);
  const pack = await prepareIsolatedPack(source, root);
  expect(verifyIsolatedPack(root, pack.name)).toBe(true);
  expect(await readFile(join(source, 'Mtp.yaml'), 'utf8')).toBe(original);
  expect(await readFile(join(source, 'CamMacros', 'begin.yaml'), 'utf8')).toContain('usable: true');
  const macroPath = join(root, pack.name, 'CamMacros', 'begin.yaml');
  const macro = await readFile(macroPath, 'utf8');
  expect(macro).toContain('usable: false');
  await writeFile(macroPath, macro.replace('usable: false', 'usable: true'));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(macroPath, macro);
  const path = join(root, pack.name, `${pack.name}.yaml`);
  const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    name: pack.name,
    KCP: { usable: false },
    OnNewRound: [],
    OnRoundStart: [],
    OnRoundEnd: [],
  });
  // Actual MulNX serialization after switching the isolated pack in-game.
  const rewritten = [
    `name: ${pack.name}`,
    'KCP:',
    '  usable: false',
    '  ctrl: false',
    '  shift: false',
    '  alt: false',
    '  vkCode: 0',
    '  comboClick: 1',
    'OnNewRound:',
    '  []',
    'OnRoundStart:',
    '  []',
    'OnRoundEnd:',
    '  []',
  ].join('\r\n');
  await writeFile(path, rewritten);
  expect(verifyIsolatedPack(root, pack.name)).toBe(true);
  await writeFile(
    path,
    `# MulNX metadata\nOnRoundEnd: []\nname: '${pack.name}'\nKCP: { usable: false, ctrl: true, shift: false, alt: false, vkCode: 67, comboClick: 2 }\nOnRoundStart: [ ]\nOnNewRound: [] # empty\n`,
  );
  expect(verifyIsolatedPack(root, pack.name)).toBe(true);
  await writeFile(path, rewritten.replace('  ctrl: false\r\n', ''));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(path, rewritten.replace('  vkCode: 0', '  vkCode: invalid'));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(path, rewritten + '\nOnNewRound: [begin]\n');
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(path, rewritten.replace('  usable: false', '  usable: "false"'));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(path, rewritten.replace('OnRoundEnd:', 'Other:'));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(path, rewritten.replace('  []', '  - begin'));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  await writeFile(path, rewritten.replace('usable: false', 'usable: true'));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
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
