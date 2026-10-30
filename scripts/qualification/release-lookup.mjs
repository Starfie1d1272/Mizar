import { validateReleaseTag } from './app-version.mjs';

// A draft has no tag yet and is deliberately absent from releases/tags/{tag}.
// Scan the complete authenticated release list; ambiguity or incomplete paging
// must never be treated as permission to create another release.
export function lookupRelease(tag, sourceSha, lookup) {
  validateReleaseTag(tag, tag.slice(1));
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid release source');
  const matches = [];
  let complete = false;
  for (let page = 1; page <= 100; page++) {
    const releases = lookup(`releases?per_page=100&page=${page}`);
    if (
      !Array.isArray(releases) ||
      releases.length > 100 ||
      releases.some(
        (release) =>
          !release ||
          typeof release.tag_name !== 'string' ||
          !Number.isSafeInteger(release.id) ||
          release.id <= 0,
      )
    )
      throw new Error('Release listing unavailable');
    matches.push(...releases.filter((release) => release?.tag_name === tag));
    if (releases.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete || matches.length > 1)
    throw new Error('Release listing is incomplete or ambiguous');
  const release = matches[0] ?? null;
  const ref = lookup(`git/ref/tags/${tag}`);
  if (!release) {
    if (ref !== null) throw new Error('Tag exists without a verified release');
    return null;
  }
  const stable = /^v\d+\.\d+\.\d+$/.test(tag);
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    typeof release.draft !== 'boolean' ||
    release.prerelease !== !stable ||
    !Array.isArray(release.assets)
  )
    throw new Error('Release identity is invalid');
  if (release.draft) {
    if (release.target_commitish !== sourceSha || ref !== null)
      throw new Error('Draft source differs or tag already exists');
  } else if (
    !release.published_at ||
    ref?.object?.type !== 'commit' ||
    ref.object.sha !== sourceSha
  ) {
    throw new Error('Published release or tag identity differs');
  }
  return release;
}
