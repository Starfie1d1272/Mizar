import { z } from 'zod';
import { updateJson, type UpdateFetch } from './network.js';

export class BoxSource {
  constructor(private readonly fetcher: UpdateFetch = globalThis.fetch) {}
  async link(path: string, signal: AbortSignal): Promise<string> {
    if (
      path !== '/Updates/latest.json' &&
      path !== '/Tools/MulNX/latest.json' &&
      !/^\/Tools\/MulNX\/[1-9][0-9]*\/[1-9][0-9]*\/(?:MulNX\.7z|LICENSE\.txt|COPYRIGHT\.md|SECURITY\.md)$/.test(
        path,
      ) &&
      !/^\/Stable\/Mizar-v\d+\.\d+\.\d+-Windows-x64-Setup\.exe$/.test(path) &&
      !/^\/Runtime\/v\d+\.\d+\.\d+\/(?:machine-metadata\.json|Mizar-v\d+\.\d+\.\d+-Windows-x64-Core-Setup\.exe)$/.test(
        path,
      )
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
}
