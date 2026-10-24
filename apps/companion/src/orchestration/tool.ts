import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, ensureDirectory, readJson, safePath } from '../resource-store/files.js';
import { prepareIsolatedPack } from './prepare-pack.js';
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
  packs: { name: string; sourceName: string }[];
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
export function consoleLaunchOptions(source: string): string {
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
  const options = /(?:^|\s)-condebug(?:\s|$)/i.test(value) ? value : `${value} -condebug`.trim();
  return source.replace(/^launchOptions\s*:.*$/m, `launchOptions: ${JSON.stringify(options)}`);
}
/** Distribution state is independent of the Mizar application and camera presets. */
export class MulnxTool {
  private installed: InstalledTool | undefined;
  private latest: MulnxRelease | undefined;
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
              }),
            )
            .max(128),
        })
        .parse(await readJson(this.directory, 'current.json'));
      await safePath(join(this.directory, data.directory), 'MulNX/CS2Injector/CS2Injector.exe');
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
  prepare(cs2Path: string, consoleCapture = false) {
    return this.run('mulnx_prepare', async () => {
      // Called only by the authenticated native host after its process and install checks.
      let release: MulnxRelease;
      try {
        release = await latestMulnxRelease();
        this.latest = release;
      } catch (error) {
        // Only metadata discovery may fall back. Installation, extraction and
        // archive integrity errors below still fail without activating new bytes.
        this.diagnostic('mulnx_update_check', { result: 'failure', error });
        if (this.installed) release = this.installed.release;
        else {
          try {
            release = z
              .object({ release: releaseSchema })
              .parse(await readJson(this.bundle, 'release.json')).release;
          } catch {
            throw new Error('MulNX 尚未准备完成，当前无法检查上游版本，请稍后重试。', {
              cause: error,
            });
          }
        }
        this.message = '暂时无法检查 MulNX 更新，正在使用本机已准备的版本。';
      }
      if (!this.installed || this.installed.release.sha256 !== release.sha256)
        await this.install(release, cs2Path);
      const root = join(this.directory, this.installed!.directory, 'MulNX');
      await this.configureLauncher(root, cs2Path, consoleCapture);
      const launcher = await safePath(root, 'CS2Injector/CS2Injector.exe');
      const launchProtocol = await readFile(join(root, 'CS2Injector/launch-protocol.txt'), 'utf8')
        .then((value) => (value.trim() === '1' ? 1 : null))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      return { launcher, version: this.installed!.release.tag, launchProtocol };
    });
  }
  private async configureLauncher(root: string, cs2Path: string, consoleCapture = false) {
    const config = await safePath(root, 'CS2Injector/CS2BootLoader/Config/config.yaml');
    const stat = await lstat(config);
    if (stat.size > 64 * 1024) throw new Error('mulnx_launcher_config_invalid');
    const original = await readFile(config, 'utf8');
    if ((original.match(/^path\s*:/gm) ?? []).length !== 1)
      throw new Error('mulnx_launcher_config_unsupported');
    // JSON strings are YAML strings; retain upstream launch options and platform checks.
    const withPath = original.replace(/^path\s*:.*$/m, `path: ${JSON.stringify(cs2Path)}`);
    const updated = consoleCapture ? consoleLaunchOptions(withPath) : withPath;
    const temporary = `${config}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, updated, { flag: 'wx' });
      await rename(temporary, config);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async install(release: MulnxRelease, cs2Path: string) {
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
      const extracted = await extractMulnx(extractor, archive, unpacked);
      const notices = join(extracted.root, 'Mizar-Upstream-Notices');
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
      const packsRoot = join(extracted.root, 'CS2OBTool/CameraSystem/CamPacks');
      const packs: InstalledTool['packs'] = [];
      const entries = await readdir(packsRoot, { withFileTypes: true });
      if (entries.length > 128) throw new Error('mulnx_pack_budget');
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('Mizar_')) continue;
        const name = `Mizar_${createHash('sha256').update(entry.name).digest('hex').slice(0, 24)}`;
        await prepareIsolatedPack(join(packsRoot, entry.name), packsRoot, name);
        packs.push({ name, sourceName: entry.name });
      }
      await this.configureLauncher(extracted.root, cs2Path);
      const directory = `release-${release.sha256}-${randomUUID()}`;
      await rename(unpacked, join(this.directory, directory));
      const installed = { release, directory, packs };
      await atomicJson(join(this.directory, 'current.json'), installed);
      this.installed = installed;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
