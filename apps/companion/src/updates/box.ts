import { z } from 'zod';
import { compareVersions, type UpdateManifest } from './contract.js';
import { boundedBytes, updateJson, updateRequest, type UpdateFetch } from './network.js';

export class BoxSource {
  constructor(private readonly fetcher: UpdateFetch = globalThis.fetch) {}
  async stable(signal: AbortSignal) {
    const entries = z
      .object({
        user_perm: z.literal('r'),
        repo_name: z.literal('Mizar'),
        dirent_list: z
          .array(
            z.object({ name: z.string(), size: z.number().int().nonnegative(), type: z.string() }),
          )
          .max(100),
      })
      .parse(
        await updateJson(
          'https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path=/Stable',
          signal,
          this.fetcher,
        ),
      );
    const packages = entries.dirent_list.flatMap((entry) => {
      const version =
        /^Mizar-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-Windows-x64-Setup\.exe$/.exec(
          entry.name,
        )?.[1];
      return entry.type === 'file' && version ? [{ ...entry, version }] : [];
    });
    packages.sort((a, b) => compareVersions(b.version, a.version));
    return packages[0] ?? null;
  }
  async link(path: string, signal: AbortSignal): Promise<string> {
    if (
      path !== '/Updates/latest.json' &&
      !/^\/Stable\/Mizar-v\d+\.\d+\.\d+-Windows-x64-Setup\.exe$/.test(path)
    )
      throw new Error('update_mirror_path_invalid');
    const url = z
      .string()
      .max(8192)
      .parse(
        await updateJson(
          `https://box.nju.edu.cn/api/v2.1/via-repo-token/download-link/?path=${encodeURIComponent(path)}`,
          signal,
          this.fetcher,
          16 * 1024,
        ),
      );
    const parsed = new URL(url);
    if (
      parsed.origin !== 'https://box.nju.edu.cn' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !parsed.pathname.startsWith('/seafhttp/files/')
    )
      throw new Error('update_mirror_link_invalid');
    return url;
  }
  async metadata(signal: AbortSignal) {
    const entries = z
      .object({ user_perm: z.literal('r'), repo_name: z.literal('Mizar') })
      .parse(
        await updateJson(
          'https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path=/Updates',
          signal,
          this.fetcher,
        ),
      );
    void entries;
    const url = await this.link('/Updates/latest.json', signal);
    return boundedBytes(await updateRequest(url, signal, this.fetcher), 2 * 1024 * 1024);
  }
  async installer(manifest: UpdateManifest, signal: AbortSignal) {
    const current = await this.stable(signal);
    if (current?.name !== manifest.installer.name || current.size !== manifest.installer.bytes)
      throw new Error('update_mirror_unavailable');
    return this.link(`/Stable/${manifest.installer.name}`, signal);
  }
}
