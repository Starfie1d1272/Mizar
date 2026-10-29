import { z } from 'zod';
import { parseDocument } from 'yaml';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, ensureDirectory, readJson, safePath } from '../resource-store/files.js';
import { prepareIsolatedPack } from './prepare-pack.js';
import { cameraSourceTreeSha256 } from './camera-source.js';
import {
  downloadVerified,
  extractMulnx,
  fileSha256,
  latestMulnxRelease,
  SEVEN_ZIP,
  upstreamNotice,
  type MulnxRelease,
} from './tool-release.js';

interface InstalledTool {
  release: MulnxRelease;
  directory: string;
  packs: { name: string; sourceName: string; treeSha256?: string | undefined }[];
}
const releaseSchema = z.object({
  id: z.number().int().positive(),
  assetId: z.number().int().positive(),
  tag: z.string().regex(/^[\w.+-]{1,100}$/),
  publishedAt: z.string(),
  url: z.string(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Preserve the official launch options; refuse unfamiliar YAML instead of
 * silently enabling capture without an effective engine flag. */
function launchOptionsValue(source: string): string {
  const lines = [...source.matchAll(/^launchOptions\s*:\s*(.*)$/gm)];
  if (lines.length !== 1) throw new Error('mulnx_launcher_config_unsupported');
  const raw = lines[0]![1]!.trim();
  const value: unknown = raw.startsWith('"')
    ? JSON.parse(raw)
    : raw.startsWith("'") && raw.endsWith("'")
      ? raw.slice(1, -1).replaceAll("''", "'")
      : raw;
  if (typeof value !== 'string' || /[\r\n#]/.test(value) || (value && !value.startsWith('-')))
    throw new Error('mulnx_launcher_config_unsupported');
  return value;
}
export function consoleLaunchOptions(source: string): string {
  const value = launchOptionsValue(source);
  const options = /(?:^|\s)-condebug(?:\s|$)/i.test(value) ? value : `${value} -condebug`.trim();
  return source.replace(/^launchOptions\s*:.*$/m, `launchOptions: ${JSON.stringify(options)}`);
}
/** Remove only the bundled first-Demo POV trigger; leave all other commands intact. */
export function firstDemoOptions(source: string): string {
  return source.replace(
    /^[\t ]*MulNX\/CSCfg\/POV[\t ]*(?=\r?$)/gim,
    '// Mizar: POV remains operator controlled',
  );
}
/** Distribution state is independent of the Mizar application and camera presets. */
export class MulnxTool {
  private installed: InstalledTool | undefined;
  private latest: MulnxRelease | undefined;
  private staged:
    { id: string; installed: InstalledTool; expected: string | undefined } | undefined;
  private pending: Promise<unknown> | undefined;
  private message = '';
  constructor(
    readonly directory: string,
    readonly bundle: string,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
  ) {}
  get camPacksRoot() {
    return this.installed
      ? join(this.directory, this.installed.directory, 'MulNX/CS2OBTool/CameraSystem/CamPacks')
      : undefined;
  }
  view() {
    return {
      installed: this.installed?.release.tag ?? null,
      latest: this.latest?.tag ?? null,
      busy: Boolean(this.pending),
      message: this.message,
      packs: this.installed?.packs ?? [],
    };
  }
  /** Read the provider's published receipts; archive bytes are reverified at selection. */
  async listPreparedReleases() {
    const names = (await readdir(this.directory)).filter((name) =>
      /^prepared-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name),
    );
    if (names.length > 256) throw new Error('mulnx_prepared_budget');
    return Promise.all(
      names.sort().map(async (preparedId) => {
        try {
          const root = await safePath(join(this.directory, preparedId));
          const { release } = z
            .object({ release: releaseSchema })
            .parse(await readJson(root, 'receipt.json'));
          if (!preparedId.startsWith(`prepared-${release.sha256}-`))
            throw new Error('mulnx_prepared_invalid');
          const archive = await safePath(root, 'MulNX.7z');
          if ((await lstat(archive)).size !== release.size)
            throw new Error('mulnx_prepared_integrity');
          return {
            preparedId,
            tag: release.tag,
            archiveSha256: release.sha256,
            state: 'available' as const,
          };
        } catch {
          return { preparedId, tag: null, archiveSha256: null, state: 'damaged' as const };
        }
      }),
    );
  }
  /** Return a portable source only after checking the selected instance's original bytes. */
  async cameraSource(name: string) {
    const installed = this.installed;
    const pack = installed?.packs.find((item) => item.name === name);
    if (!installed || !pack?.treeSha256) throw new Error('mulnx_source_unverified');
    const root = await safePath(
      join(this.directory, installed.directory, 'MulNX/CS2OBTool/CameraSystem/CamPacks'),
    );
    if (
      !pack.sourceName ||
      pack.sourceName.trim() !== pack.sourceName ||
      pack.sourceName.length > 120 ||
      /[\\/]/.test(pack.sourceName) ||
      [...pack.sourceName].some((character) => character.charCodeAt(0) < 32) ||
      pack.sourceName === '.' ||
      pack.sourceName === '..'
    )
      throw new Error('mulnx_source_invalid');
    const treeSha256 = await cameraSourceTreeSha256(join(root, pack.sourceName));
    if (treeSha256 !== pack.treeSha256) throw new Error('mulnx_source_changed');
    return {
      sourceName: pack.sourceName,
      treeSha256,
      converterVersion: 1 as const,
      acquisition: {
        kind: 'upstream' as const,
        release: {
          repository: 'Co1Swet/MulNX_CS2' as const,
          releaseId: installed.release.id,
          assetId: installed.release.assetId,
          tag: installed.release.tag,
          archiveSha256: installed.release.sha256,
        },
      },
    };
  }
  async load() {
    await ensureDirectory(this.directory);
    try {
      const data = z
        .object({
          directory: z.string().regex(/^release-[a-f0-9]{64}-[a-f0-9-]{36}$/),
          release: releaseSchema,
          packs: z
            .array(
              z.object({
                name: z.string().regex(/^Mizar_[a-f0-9]{24}$/),
                sourceName: z.string().min(1).max(256),
                treeSha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
              }),
            )
            .max(128),
        })
        .parse(await readJson(this.directory, 'current.json'));
      this.installed = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private run<T>(action: string, operation: () => Promise<T>): Promise<T> {
    if (this.pending) return Promise.reject(new Error('mulnx_operation_busy'));
    this.message = '';
    this.diagnostic(action, { result: 'begin' });
    const task = operation()
      .then((result) => {
        this.diagnostic(action, { result: 'success', version: this.installed?.release.tag });
        return result;
      })
      .catch((error: unknown) => {
        this.message = error instanceof Error ? error.message : String(error);
        this.diagnostic(action, { result: 'failure', error });
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    this.pending = task;
    return task;
  }
  check() {
    return this.run('mulnx_check', async () => {
      this.latest = await latestMulnxRelease();
      return this.view();
    });
  }
  prepare(
    cs2Path: string,
    consoleCapture = false,
    update = false,
    spectatorCfg = false,
    demoCfg?: string,
  ) {
    return this.run('mulnx_prepare', async () => {
      // Called only by the authenticated native host after its process and install checks.
      // Entry uses prepared local bytes. The explicit update action owns network discovery.
      let launcherUnavailable = false;
      if (this.installed) {
        // Recheck the actual file on every attempt; the receipt alone cannot prove it is usable.
        try {
          const path = await safePath(
            join(this.directory, this.installed.directory),
            'MulNX/CS2Injector/CS2Injector.exe',
          );
          const file = await open(path, 'r');
          try {
            await file.read(Buffer.alloc(1), 0, 1, 0);
          } finally {
            await file.close();
          }
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
          if (!update)
            throw new Error(
              'MulNX 启动程序缺失或无法读取。请核对官方来源及 Windows 安全中心的检测记录；处理后重新进入工作台以检查文件；文件已删除时，可在“设置 → 运镜”点击更新 MulNX 重新安装。旧版本文件和设置已保留。仍无法使用时，可在“设置 → 游戏与观战 → CS2 启动设置”选择标准启动并保存。',
              { cause: error },
            );
          launcherUnavailable = true;
        }
      }
      const release = update
        ? await latestMulnxRelease()
        : (this.installed?.release ??
          z.object({ release: releaseSchema }).parse(await readJson(this.bundle, 'release.json'))
            .release);
      if (
        update ||
        launcherUnavailable ||
        !this.installed ||
        this.installed.release.sha256 !== release.sha256
      )
        await this.install(release, cs2Path, consoleCapture, spectatorCfg, demoCfg);
      const root = join(this.directory, this.installed!.directory, 'MulNX');
      await this.configureLauncher(root, cs2Path, consoleCapture, spectatorCfg, demoCfg);
      const launcher = await safePath(root, 'CS2Injector/CS2Injector.exe');
      return { launcher, version: this.installed!.release.tag };
    });
  }
  private async replaceManaged(path: string, original: string, updated: string) {
    if (original === updated) return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, updated, { flag: 'wx' });
      if ((await readFile(path, 'utf8')) !== original) throw new Error('mulnx_config_conflict');
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async configureReflection(root: string, relative: string, key: string) {
    const path = await safePath(root, relative);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new Error('mulnx_config_invalid');
    const original = await readFile(path, 'utf8');
    const document = parseDocument(original, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('mulnx_config_invalid');
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('mulnx_config_invalid');
    document.set(key, false);
    await this.replaceManaged(path, original, document.toString());
  }
  private async configureFirstDemo(root: string) {
    const relative = 'CS2OBTool/AutoCfgLoad/FirstPlayDemo';
    let directory: string;
    try {
      directory = await safePath(join(root, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.cfg')) continue;
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
        throw new Error('mulnx_first_demo_config_invalid');
      const original = await readFile(path, 'utf8');
      await this.replaceManaged(path, original, firstDemoOptions(original));
    }
  }
  private async configureLauncher(
    root: string,
    cs2Path: string,
    consoleCapture = false,
    spectatorCfg = false,
    demoCfg?: string,
  ) {
    await this.configureReflection(root, 'Config/CS2OBTool_Refl.yaml', 'UISystem.ifDrawMid');
    await this.configureReflection(
      root,
      'Config/CS2Injector_Refl.yaml',
      'CS2HelperController.injectReshade',
    );
    await this.configureFirstDemo(root);
    const auto = await readFile(
      await safePath(root, 'CS2Injector/CS2BootLoader/Config/auto.yaml'),
      'utf8',
    );
    if (
      (auto.match(/^autoLaunch\s*:/gm) ?? []).length !== 1 ||
      !/^autoLaunch\s*:\s*false\s*(?:#.*)?$/m.test(auto)
    )
      throw new Error('mulnx_launcher_config_unsupported');
    try {
      const socketConfig = await readFile(
        await safePath(root, 'CS2Injector/WebSocketManager/Config/config.yaml'),
        'utf8',
      );
      if (
        (socketConfig.match(/^port\s*:/gm) ?? []).length !== 1 ||
        !/^port\s*:\s*55203\s*(?:#.*)?$/m.test(socketConfig)
      )
        throw new Error('mulnx_launcher_config_unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const config = await safePath(root, 'CS2Injector/CS2BootLoader/Config/config.yaml');
    const stat = await lstat(config);
    if (stat.size > 64 * 1024) throw new Error('mulnx_launcher_config_invalid');
    const original = await readFile(config, 'utf8');
    if ((original.match(/^path\s*:/gm) ?? []).length !== 1)
      throw new Error('mulnx_launcher_config_unsupported');
    // JSON strings are YAML strings; retain upstream launch options and platform checks.
    const withPath = original.replace(/^path\s*:.*$/m, `path: ${JSON.stringify(cs2Path)}`);
    const ownership = join(root, 'mizar-console-options.json');
    let owned: { original: string; managed: string; previous?: string | undefined } | undefined;
    try {
      owned = z
        .object({
          original: z.string().max(65536),
          managed: z.string().max(65536),
          previous: z.string().max(65536).optional(),
        })
        .parse(await readJson(root, 'mizar-console-options.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const line = withPath.match(/^launchOptions\s*:.*$/m)?.[0];
    if (!line) throw new Error('mulnx_launcher_config_unsupported');
    if (owned && ![owned.original, owned.managed, owned.previous].includes(line))
      throw new Error('mulnx_console_ownership_conflict');
    // Derive every requested combination from the saved user line. A transition
    // record accepts both the old and new managed lines if a crash interrupts it.
    const originalLine = owned?.original ?? line;
    const baseline = withPath.replace(/^launchOptions\s*:.*$/m, originalLine);
    let options = launchOptionsValue(baseline);
    if (consoleCapture && !/(?:^|\s)-condebug(?:\s|$)/i.test(options))
      options = `${options} -condebug`.trim();
    if (
      spectatorCfg &&
      !/(?:^|\s)\+exec\s+(?:"mizar_observer\.cfg"|mizar_observer\.cfg)(?=\s|$)/i.test(options)
    )
      options = `${options} +exec mizar_observer.cfg`.trim();
    if (demoCfg) {
      if (!/^mizar_demo_[0-9a-f-]{36}\.cfg$/i.test(demoCfg))
        throw new Error('mulnx_demo_config_invalid');
      options = `${options} +exec ${demoCfg}`.trim();
    }
    const baselineOptions = launchOptionsValue(baseline);
    const managedLine =
      options === baselineOptions ? originalLine : `launchOptions: ${JSON.stringify(options)}`;
    const updated = withPath.replace(/^launchOptions\s*:.*$/m, managedLine);
    if (managedLine !== originalLine || owned) {
      // The previous accepted line makes both sides of an interrupted rename recoverable.
      await atomicJson(ownership, { original: originalLine, managed: managedLine, previous: line });
    }
    const temporary = `${config}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, updated, { flag: 'wx' });
      if ((await readFile(config, 'utf8')) !== original)
        throw new Error('mulnx_console_ownership_conflict');
      await rename(temporary, config);
      if (managedLine === originalLine) await rm(ownership, { force: true });
      else await atomicJson(ownership, { original: originalLine, managed: managedLine });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Download and verify an upstream release without changing the selected instance. */
  prepareRelease(update = true) {
    return this.run('mulnx_prepare_release', async () => {
      const release = update
        ? await latestMulnxRelease()
        : z.object({ release: releaseSchema }).parse(await readJson(this.bundle, 'release.json'))
            .release;
      return this.prepareReleaseFiles(release);
    });
  }

  /** Native host must hold its launch and process/recovery guards while selecting. */
  selectRelease(preparedId: string, cs2Path: string) {
    return this.run('mulnx_select_release', async () => {
      const installed = await this.selectReleaseFiles(preparedId, cs2Path);
      await this.publishSelection(installed);
    });
  }

  /** Prepare the configured instance before the native host's final process check. */
  stageSelection(preparedId: string, cs2Path: string, consoleCapture: boolean) {
    return this.run('mulnx_stage_selection', async () => {
      const expected = this.installed?.directory;
      this.staged = undefined;
      const installed = await this.selectReleaseFiles(preparedId, cs2Path, consoleCapture);
      const id = randomUUID();
      this.staged = { id, installed, expected };
      return { id };
    });
  }

  commitSelection(id: string) {
    return this.run('mulnx_commit_selection', async () => {
      const staged = this.staged;
      if (!staged || staged.id !== id || staged.expected !== this.installed?.directory)
        throw new Error('mulnx_selection_changed');
      await safePath(
        join(this.directory, staged.installed.directory),
        'MulNX/CS2Injector/CS2Injector.exe',
      );
      await this.publishSelection(staged.installed);
      this.staged = undefined;
      return { version: staged.installed.release.tag };
    });
  }

  private async publishSelection(installed: InstalledTool) {
    try {
      await atomicJson(join(this.directory, 'current.json'), installed);
    } catch (error) {
      // A directory-sync failure can occur after rename. Read back before deciding.
      let persisted: unknown;
      try {
        persisted = await readJson(this.directory, 'current.json');
      } catch {
        throw new Error('mulnx_selection_unconfirmed', { cause: error });
      }
      if (JSON.stringify(persisted) !== JSON.stringify(installed)) throw error;
    }
    this.installed = installed;
  }

  private async install(
    release: MulnxRelease,
    cs2Path: string,
    consoleCapture: boolean,
    spectatorCfg: boolean,
    demoCfg?: string,
  ) {
    const prepared = await this.prepareReleaseFiles(release);
    const installed = await this.selectReleaseFiles(
      prepared.preparedId,
      cs2Path,
      consoleCapture,
      spectatorCfg,
      demoCfg,
    );
    await this.publishSelection(installed);
  }

  private async prepareReleaseFiles(release: MulnxRelease) {
    await safePath(this.directory);
    const extractor = await safePath(this.bundle, '7zr.exe');
    if ((await fileSha256(extractor)) !== SEVEN_ZIP.sha256)
      throw new Error('mulnx_extractor_integrity');
    const stage = join(this.directory, `staging-${randomUUID()}`);
    await mkdir(stage);
    try {
      const archive = join(stage, 'MulNX.7z');
      const bundled = (await readJson(this.bundle, 'release.json')) as { release?: MulnxRelease };
      const usingBundle = bundled?.release?.sha256 === release.sha256;
      if (usingBundle) {
        const source = await safePath(this.bundle, 'MulNX.7z');
        await copyFile(source, archive);
        if (
          (await lstat(archive)).size !== release.size ||
          (await fileSha256(archive)) !== release.sha256
        )
          throw new Error('mulnx_bundle_integrity');
      } else await downloadVerified(release.url, archive, release.sha256, release.size);
      const unpacked = join(stage, 'unpacked');
      await extractMulnx(extractor, archive, unpacked);
      const notices = join(stage, 'Mizar-Upstream-Notices');
      await mkdir(notices);
      const copies = await Promise.allSettled(
        ['LICENSE.txt', 'COPYRIGHT.md', 'SECURITY.md'].map(async (name) => {
          const content = usingBundle
            ? await readFile(await safePath(this.bundle, `MulNX-${name}`))
            : await upstreamNotice(name, release.tag);
          await writeFile(join(notices, name), content, { flag: 'wx' });
        }),
      );
      const failed = copies.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await writeFile(
        join(notices, 'SOURCES.txt'),
        `MulNX ${release.tag}\nhttps://github.com/Co1Swet/MulNX_CS2/tree/${release.tag}\nhttps://github.com/Co1Swet/MulNX_CS2/archive/refs/tags/${release.tag}.zip\n`,
        { flag: 'wx' },
      );
      // Publish the verified archive and receipt together; no machine configuration is written here.
      const preparedId = `prepared-${release.sha256}-${randomUUID()}`;
      await writeFile(join(stage, 'receipt.json'), JSON.stringify({ release }), { flag: 'wx' });
      await rm(unpacked, { recursive: true, force: true });
      await rename(stage, join(this.directory, preparedId));
      return { preparedId, release };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private async selectReleaseFiles(
    preparedId: string,
    cs2Path: string,
    consoleCapture = false,
    spectatorCfg = false,
    demoCfg?: string,
  ) {
    if (!/^prepared-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(preparedId))
      throw new Error('mulnx_prepared_invalid');
    const prepared = await safePath(join(this.directory, preparedId));
    const { release } = z
      .object({ release: releaseSchema })
      .parse(await readJson(prepared, 'receipt.json'));
    if (!preparedId.startsWith(`prepared-${release.sha256}-`))
      throw new Error('mulnx_prepared_invalid');
    const archive = await safePath(prepared, 'MulNX.7z');
    if (
      (await lstat(archive)).size !== release.size ||
      (await fileSha256(archive)) !== release.sha256
    )
      throw new Error('mulnx_prepared_integrity');
    const extractor = await safePath(this.bundle, '7zr.exe');
    if ((await fileSha256(extractor)) !== SEVEN_ZIP.sha256)
      throw new Error('mulnx_extractor_integrity');
    const stage = join(this.directory, `staging-${randomUUID()}`);
    await mkdir(stage);
    try {
      const unpacked = join(stage, 'unpacked');
      const extracted = await extractMulnx(extractor, archive, unpacked);
      const notices = join(extracted.root, 'Mizar-Upstream-Notices');
      await mkdir(notices);
      for (const name of ['LICENSE.txt', 'COPYRIGHT.md', 'SECURITY.md', 'SOURCES.txt'])
        await copyFile(
          await safePath(prepared, `Mizar-Upstream-Notices/${name}`),
          join(notices, name),
        );
      const packsRoot = join(extracted.root, 'CS2OBTool/CameraSystem/CamPacks');
      const packs: InstalledTool['packs'] = [];
      const entries = await readdir(packsRoot, { withFileTypes: true });
      if (entries.length > 128) throw new Error('mulnx_pack_budget');
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('Mizar_')) continue;
        const name = `Mizar_${createHash('sha256').update(entry.name).digest('hex').slice(0, 24)}`;
        const treeSha256 = await cameraSourceTreeSha256(join(packsRoot, entry.name));
        await prepareIsolatedPack(join(packsRoot, entry.name), packsRoot, name);
        packs.push({ name, sourceName: entry.name, treeSha256 });
      }
      await this.configureLauncher(extracted.root, cs2Path, consoleCapture, spectatorCfg, demoCfg);
      const directory = `release-${release.sha256}-${randomUUID()}`;
      await rename(unpacked, join(this.directory, directory));
      return { release, directory, packs };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
