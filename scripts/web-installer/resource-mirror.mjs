import { RESOURCE_ASSET_NAMES } from '@mizar/resource-pack-contract/runtime';
import { updateJson, updateRequest, boundedBytes } from '../updates/network.js';

const fixedNames = new Set(Object.values(RESOURCE_ASSET_NAMES));
export function mirrorResourcePath(version, name) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !(
      fixedNames.has(name) ||
      /^Mizar-official-epl-default-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.zip$/.test(name)
    )
  )
    throw new Error('resource_mirror_path_invalid');
  return `/Resources/v${version}/${name}`;
}
// Transport only. Original canonical catalog URLs and all publisher claims stay
// unchanged; the existing SDK authenticates the returned original bytes.
export async function downloadResourceOriginal({
  version,
  name,
  maximum,
  signal,
  fetcher,
  sourceMode = 'auto',
}) {
  const path = mirrorResourcePath(version, name);
  const deadline = globalThis.AbortSignal.any([
    signal,
    globalThis.AbortSignal.timeout(maximum > 2097152 ? 300000 : 60000),
  ]);
  try {
    if (sourceMode === 'github') throw new Error('resource_github_transport');
    const attempt = globalThis.AbortSignal.any([deadline, globalThis.AbortSignal.timeout(15000)]);
    const directory = await updateJson(
      `https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path=${encodeURIComponent('/Resources/v' + version)}`,
      attempt,
      fetcher,
    );
    if (directory.repo_name !== 'Mizar' || directory.user_perm !== 'r')
      throw new Error('resource_mirror_permission_invalid');
    const link = await updateJson(
      `https://box.nju.edu.cn/api/v2.1/via-repo-token/download-link/?path=${encodeURIComponent(path)}`,
      attempt,
      fetcher,
      16384,
    );
    if (typeof link !== 'string' || link.length > 8192)
      throw new Error('resource_mirror_link_invalid');
    const url = new globalThis.URL(link);
    if (
      url.origin !== 'https://box.nju.edu.cn' ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith('/seafhttp/files/')
    )
      throw new Error('resource_mirror_link_invalid');
    // Never fall back after bytes have arrived and failed publisher verification.
    return await boundedBytes(await updateRequest(url.href, deadline, fetcher), maximum);
  } catch {
    deadline.throwIfAborted();
    // All fallback bytes undergo the same sole SDK verification. No metadata,
    // pin or authority is taken from the failed mirror response.
    return boundedBytes(
      await updateRequest(
        `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${name}`,
        deadline,
        fetcher,
      ),
      maximum,
    );
  }
}
