import { execFileSync } from 'node:child_process';
import { cp, readFile, realpath, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const script = resolve(import.meta.dirname, 'bundle/gsi-discovery.ps1');
function run(source, isolatedSteam = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const isolation = isolatedSteam
    ? `function Get-ItemProperty { [CmdletBinding()] param([string]$LiteralPath) [pscustomobject]@{} }; $env:ProgramFiles=''; \${env:ProgramFiles(x86)}='';`
    : '';
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; ${isolation} . ${quote(script)}; ${source}`,
    ],
    {
      env,
      encoding: 'utf8',
      timeout: 15000,
    },
  ).trim();
}
async function library() {
  // Windows TEMP can use an 8.3 alias; expected paths must use the filesystem identity.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mizar-steam-paths-')));
  roots.push(root);
  await mkdir(join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg'), {
    recursive: true,
  });
  const exe = join(root, 'steamapps/common/Counter-Strike Global Offensive/game/bin/win64');
  await mkdir(exe, { recursive: true });
  await writeFile(join(exe, 'cs2.exe'), 'fixture');
  await writeFile(
    join(root, 'steamapps/libraryfolders.vdf'),
    `"libraryfolders"\n{\n"0"\n{\n"path" "${root.replaceAll('\\', '\\\\')}"\n}\n}\n`,
  );
  return root;
}

describe.skipIf(process.platform !== 'win32')('Windows Steam directory discovery', () => {
  // This lifecycle intentionally launches several real Windows PowerShell processes.
  it(
    'automatically prepares only owned GSI, preserves its token, and refuses unknown senders',
    { timeout: 20_000 },
    async () => {
      const root = await library();
      const product = join(root, 'product');
      const resources = join(product, 'resources');
      await cp(resolve(import.meta.dirname, 'bundle'), join(resources, 'scripts'), {
        recursive: true,
      });
      await mkdir(join(resources, 'config'), { recursive: true });
      await cp(
        resolve(import.meta.dirname, '../../config/gamestate_integration_mizar.cfg.example'),
        join(resources, 'config/gamestate_integration_mizar.cfg.template'),
      );
      const state = join(root, 'state');
      const cfg = join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg');
      const canonical = join(cfg, 'gamestate_integration_mizar.cfg');
      const duplicate = join(cfg, 'gamestate_integration_other.cfg');
      const ensure = join(resources, 'scripts/ensure-gsi.ps1');
      const prepare = () =>
        run(
          `$env:MIZAR_STATE_ROOT=${quote(state)}; $env:STEAMROOT=${quote(root)}; & ${quote(ensure)} -Product`,
          true,
        );
      await writeFile(duplicate, '"uri" "http://localhost:3000/"');
      expect(prepare).toThrow();
      expect(await readFile(duplicate, 'utf8')).toContain('3000');
      await rm(duplicate);
      await writeFile(canonical, 'operator-owned');
      expect(prepare).toThrow();
      expect(await readFile(canonical, 'utf8')).toBe('operator-owned');
      await rm(canonical);
      prepare();
      const installed = await readFile(canonical, 'utf8');
      const record = await readFile(join(state, 'data/gsi-install/install.json'), 'utf8');
      prepare();
      expect(await readFile(canonical, 'utf8')).toBe(installed);
      expect(await readFile(join(state, 'data/gsi-install/install.json'), 'utf8')).toBe(record);
      await rm(canonical);
      prepare();
      expect(await readFile(canonical, 'utf8')).toBe(installed);
      await writeFile(canonical, 'operator-edited');
      expect(prepare).toThrow();
      expect(await readFile(canonical, 'utf8')).toBe('operator-edited');
    },
  );

  it('deduplicates slash, case, trailing separator and VDF aliases of one installation', async () => {
    const root = await library();
    const alias = root.replaceAll('\\', '/').toUpperCase() + '/';
    const cfg = run(
      `function Get-SteamInstallRoots { @(${quote(root)}, ${quote(alias)}) }; Resolve-CfgDirectory`,
    );
    expect(cfg.toLowerCase()).toBe(
      join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg').toLowerCase(),
    );
  });
  it('still rejects genuinely different installations', async () => {
    const first = await library();
    const second = await library();
    const result = run(
      `function Get-SteamInstallRoots { @(${quote(first)}, ${quote(second)}) }; try { Resolve-CfgDirectory; throw 'unexpected success' } catch { if ($_.Exception.Data['CandidateCount'] -ne 2) { throw }; 'multiple installations' }`,
    );
    expect(result).toBe('multiple installations');
  });
  it('uses AppID 730 metadata and keeps an old cfg in the same installation from causing ambiguity', async () => {
    const root = await library();
    const original = join(root, 'steamapps/common/Counter-Strike Global Offensive');
    const custom = join(root, 'steamapps/common/Custom CS2');
    const { rename } = await import('node:fs/promises');
    await rename(original, custom);
    await mkdir(join(custom, 'csgo/cfg'), { recursive: true });
    await writeFile(
      join(root, 'steamapps/appmanifest_730.acf'),
      '"AppState" { "appid" "730" "installdir" "Custom CS2" }',
    );
    const cfg = run(`function Get-SteamInstallRoots { @(${quote(root)}) }; Resolve-CfgDirectory`);
    expect(cfg.toLowerCase()).toBe(join(custom, 'game/csgo/cfg').toLowerCase());
  });

  it('accepts the installation, win64 folder and executable and rejects an unrelated cfg directory', async () => {
    const root = await library();
    const game = join(root, 'steamapps/common/Counter-Strike Global Offensive');
    const cfg = join(game, 'game/csgo/cfg');
    await mkdir(join(game, 'csgo/cfg'), { recursive: true });
    for (const input of [
      game,
      cfg,
      join(game, 'game/bin/win64'),
      join(game, 'game/bin/win64/cs2.exe'),
    ]) {
      expect(run(`Resolve-CfgDirectory -ExplicitRoot ${quote(input)}`).toLowerCase()).toBe(
        cfg.toLowerCase(),
      );
    }
    const unrelated = join(root, 'unrelated/cfg');
    await mkdir(unrelated, { recursive: true });
    expect(
      run(
        `try { Resolve-CfgDirectory -ExplicitRoot ${quote(unrelated)} } catch { $_.Exception.Data['MizarCode'] }`,
      ),
    ).toBe('selected-path-invalid');
  });

  it('parses extra libraries structurally, including old-format entries, comments and escaped paths', async () => {
    const primary = await library();
    const extra = await library();
    const { rename } = await import('node:fs/promises');
    await rename(join(primary, 'steamapps/common'), join(primary, 'unused-common'));
    for (const entry of [
      `"1" { "path" "${extra.replaceAll('\\', '\\\\')}" "apps" { "730" "1" } }`,
      `"1" "${extra.replaceAll('\\', '\\\\')}"`,
    ]) {
      await writeFile(
        join(primary, 'steamapps/libraryfolders.vdf'),
        `// library metadata\n"libraryfolders" { ${entry} }`,
      );
      expect(
        run(
          `function Get-SteamInstallRoots { @(${quote(primary)}) }; Resolve-CfgDirectory`,
        ).toLowerCase(),
      ).toBe(
        join(extra, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg').toLowerCase(),
      );
    }
  });

  it('persists a native selection for subsequent discovery and reports a removed selection instead of silently switching', async () => {
    const root = await library();
    const state = join(root, 'state');
    const exe = join(
      root,
      'steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe',
    );
    const selector = resolve(import.meta.dirname, 'bundle/select-cs2-installation.ps1');
    run(
      `$env:MIZAR_STATE_ROOT=${quote(state)}; & ${quote(selector)} -Product -Cs2Root ${quote(exe)}`,
    );
    // Saving an existing choice exercises atomic replacement as well as creation.
    run(
      `$env:MIZAR_STATE_ROOT=${quote(state)}; & ${quote(selector)} -Product -Cs2Root ${quote(exe)}`,
    );
    const cfg = run(
      `$env:MIZAR_STATE_ROOT=${quote(state)}; function Get-SteamInstallRoots { @() }; Resolve-CfgDirectory`,
    );
    expect(cfg.toLowerCase()).toBe(
      join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg').toLowerCase(),
    );
    let failure;
    try {
      run(
        `$env:MIZAR_STATE_ROOT=${quote(state)}; & ${quote(selector)} -Product -Cs2Root ${quote(join(root, 'unrelated'))}`,
      );
    } catch (error) {
      failure = JSON.parse(error.stdout.toString());
    }
    expect(failure).toEqual({ error: { code: 'selected-path-missing', stage: 'selection' } });
    await rm(exe);
    expect(
      run(
        `$env:MIZAR_STATE_ROOT=${quote(state)}; try { Resolve-CfgDirectory } catch { $_.Exception.Data['MizarCode'] }`,
      ),
    ).toBe('selected-path-invalid');
  });

  it('reports no-installation and both file and endpoint conflicts without losing status to an empty path', async () => {
    const root = await library();
    const state = join(root, 'state');
    const game = join(root, 'steamapps/common/Counter-Strike Global Offensive');
    const cfg = join(game, 'game/csgo/cfg');
    const statusScript = resolve(import.meta.dirname, 'bundle/gsi-status.ps1');
    const status = () =>
      JSON.parse(
        run(
          `$env:MIZAR_STATE_ROOT=${quote(state)}; $env:STEAMROOT=${quote(root)}; & ${quote(statusScript)}`,
          true,
        ),
      );
    await mkdir(join(state, 'data/gsi-install'), { recursive: true });
    await writeFile(
      join(state, 'data/gsi-install/install.json'),
      JSON.stringify({
        cfgPath: join(cfg, 'gamestate_integration_mizar.cfg'),
        cfgFingerprint: 'old',
      }),
    );
    await writeFile(join(cfg, 'gamestate_integration_mizar.cfg'), 'changed');
    await writeFile(
      join(cfg, 'gamestate_integration_duplicate.cfg'),
      '"uri" "http://localhost:3000/"',
    );
    await writeFile(
      join(cfg, 'gamestate_integration_other-tool.cfg'),
      '"uri" "http://localhost:4000/"',
    );
    const conflict = status();
    expect(conflict.issueCodes).toEqual(
      expect.arrayContaining(['gsi-file-changed', 'endpoint-conflict']),
    );
    expect(conflict.conflictFiles).toEqual([join(cfg, 'gamestate_integration_duplicate.cfg')]);
    expect(conflict.readFailed).toBe(false);
    await rm(join(state, 'data/gsi-install'), { recursive: true });
    await rm(join(game, 'game/bin/win64/cs2.exe'));
    const missing = status();
    expect(missing.detected).toBe(false);
    expect(missing.conflict).toBe(false);
    expect(missing.issueCodes).toContain('installation-not-found');
  });
  it(
    'explicit repair suspends duplicate senders, preserves other endpoints and restores without overwriting new files',
    { timeout: 20_000 },
    async () => {
      const root = await library();
      const cfg = join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg');
      const state = join(root, 'state/data/gsi-install');
      const common = resolve(import.meta.dirname, 'bundle/common.ps1');
      const canonical = join(cfg, 'gamestate_integration_mizar.cfg');
      const duplicate = join(cfg, 'gamestate_integration_duplicate.cfg');
      const other = join(cfg, 'gamestate_integration_other.cfg');
      await writeFile(canonical, 'canonical');
      await writeFile(duplicate, '"uri" "http://localhost:3000/"');
      await writeFile(other, '"uri" "http://localhost:4000/"');
      const invoke = (source) =>
        run(`. ${quote(common)}; $script:QualificationStateRoot=${quote(state)}; ${source}`);
      const suspend = `Suspend-GsiEndpointConflicts -CfgDirectory ${quote(cfg)} -CanonicalCfgPath ${quote(canonical)}`;
      const restore = `Restore-GsiEndpointConflicts -CfgDirectory ${quote(cfg)}`;
      invoke(suspend);
      invoke(suspend); // Idempotent: the original backup survives a retry.
      const { readFile, access } = await import('node:fs/promises');
      await expect(access(duplicate)).rejects.toThrow();
      expect(await readFile(other, 'utf8')).toContain('4000');
      expect(await readFile(canonical, 'utf8')).toBe('canonical');
      await writeFile(duplicate, 'new sender from another application');
      expect(invoke(`try { ${restore}; 'unexpected success' } catch { 'preserved' }`)).toBe(
        'preserved',
      );
      expect(await readFile(duplicate, 'utf8')).toBe('new sender from another application');
      await rm(duplicate);
      invoke(restore);
      invoke(restore);
      expect(await readFile(duplicate, 'utf8')).toBe('"uri" "http://localhost:3000/"');
      // Simulate interruption after journaling but before the original was removed.
      invoke(suspend);
      invoke(restore);
      invoke(suspend);
      await expect(access(duplicate)).rejects.toThrow();
      const journal = JSON.parse(await readFile(join(state, 'conflicts.json'), 'utf8'));
      await writeFile(journal.entries[0].backupPath, 'corrupted backup');
      expect(invoke(`try { ${restore}; 'unexpected success' } catch { 'preserved' }`)).toBe(
        'preserved',
      );
      await expect(access(duplicate)).rejects.toThrow();
      expect(await readFile(other, 'utf8')).toContain('4000');
    },
  );
});
