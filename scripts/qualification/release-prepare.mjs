import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { readAppVersion, validateReleaseTag } from './app-version.mjs';
import { checkReleaseNotes } from './check-release-notes.mjs';
import { releaseSections } from './release-notes.mjs';

const stablePattern = /^\d+\.\d+\.\d+$/;

function replaceTomlSectionVersion(toml, sectionHeader, version) {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\]\\r?$`, 'm').exec(toml);
  if (!header) throw new Error(`Cargo.toml 缺少 [${sectionHeader}] 节`);
  const sectionStart = toml.indexOf('\n', header.index) + 1;
  const nextSection = /^\[[^\r\n]+\]\r?$/gm;
  nextSection.lastIndex = sectionStart;
  const sectionEnd = nextSection.exec(toml)?.index ?? toml.length;
  const sectionText = toml.slice(sectionStart, sectionEnd);
  const ownVersion = /^(version[ \t]*=[ \t]*)"[^"\r\n]+"(?=[ \t]*(?:#[^\r\n]*)?\r?$)/gm;
  if ([...sectionText.matchAll(ownVersion)].length !== 1) {
    throw new Error(`Cargo.toml [${sectionHeader}] 必须包含且仅包含一个 version 字段`);
  }
  return (
    toml.slice(0, sectionStart) +
    sectionText.replace(ownVersion, `$1"${version}"`) +
    toml.slice(sectionEnd)
  );
}

function replaceLockPackageVersions(lock, packageNames, version) {
  let updated = lock;
  for (const name of packageNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(^\\[\\[package\\]\\]\\r?\\nname[ \t]*=[ \t]*"${escaped}"\\r?\\nversion[ \t]*=[ \t]*)"[^"\r\n]+"`,
      'gm',
    );
    if ([...updated.matchAll(pattern)].length !== 1) {
      throw new Error(`Cargo.lock 必须包含且仅包含一个 ${name} 包条目`);
    }
    updated = updated.replace(pattern, `$1"${version}"`);
  }
  return updated;
}

function promoteUnreleasedChangelog(changelog, version) {
  const sections = releaseSections(changelog);
  if (sections.has(version)) {
    checkReleaseNotes(changelog, version);
    return { nextChangelog: changelog, promoted: false, hasPrerelease: false };
  }
  const unreleased = sections.get('Unreleased');
  if (!unreleased?.trim()) {
    throw new Error(
      `CHANGELOG.md 中缺少 [${version}] 且 [Unreleased] 无有效内容，请先编写更新日志`,
    );
  }
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const unreleasedIdx = lines.findIndex((line) => /^## \[Unreleased\][ \t]*$/.test(line));
  if (unreleasedIdx < 0) {
    throw new Error('CHANGELOG.md 缺少 ## [Unreleased] 标题');
  }
  let nextSectionIdx = lines.length;
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      nextSectionIdx = i;
      break;
    }
  }
  const replacement = [
    '## [Unreleased]',
    '',
    `## [${version}]`,
    '',
    ...unreleased.split('\n'),
    ...(nextSectionIdx < lines.length ? [''] : []),
  ];
  const nextLines = [
    ...lines.slice(0, unreleasedIdx),
    ...replacement,
    ...lines.slice(nextSectionIdx),
  ];
  let nextChangelog = nextLines.join('\n');
  if (!nextChangelog.endsWith('\n')) nextChangelog += '\n';
  checkReleaseNotes(nextChangelog, version);
  const hasPrerelease =
    stablePattern.test(version) &&
    [...sections.keys()].some((item) => item.startsWith(`${version}-`));
  return { nextChangelog, promoted: true, hasPrerelease };
}

export async function prepareRelease(
  version,
  { root = new URL('../../', import.meta.url), dryRun = false, log = console.log } = {},
) {
  if (!version) throw new Error('用法：pnpm release:prepare <version> [--dry-run]');
  validateReleaseTag(`v${version}`, version);

  const rootUrl =
    root instanceof URL ? root : pathToFileURL(`${resolve(root).replace(/\/?$/, '/')}`);

  const changelogPath = new URL('CHANGELOG.md', rootUrl);
  const currentChangelog = await readFile(changelogPath, 'utf8');
  const { nextChangelog, promoted, hasPrerelease } = promoteUnreleasedChangelog(
    currentChangelog,
    version,
  );
  if (hasPrerelease) {
    log(`提醒：检测到 ${version} 的预发布章节，请确认正式版日志已汇总期间 RC 的累计变更。`);
  }

  const targets = [
    {
      rel: 'CHANGELOG.md',
      url: changelogPath,
      current: currentChangelog,
      next: nextChangelog,
    },
  ];

  const desktopCargoUrl = new URL('apps/desktop/src-tauri/Cargo.toml', rootUrl);
  const desktopCargo = await readFile(desktopCargoUrl, 'utf8');
  targets.push({
    rel: 'apps/desktop/src-tauri/Cargo.toml',
    url: desktopCargoUrl,
    current: desktopCargo,
    next: replaceTomlSectionVersion(desktopCargo, 'package', version),
  });

  const installerCargoUrl = new URL('apps/desktop/installer/Cargo.toml', rootUrl);
  const installerCargo = await readFile(installerCargoUrl, 'utf8');
  targets.push({
    rel: 'apps/desktop/installer/Cargo.toml',
    url: installerCargoUrl,
    current: installerCargo,
    next: replaceTomlSectionVersion(installerCargo, 'workspace.package', version),
  });

  const tauriConfUrl = new URL('apps/desktop/src-tauri/tauri.conf.json', rootUrl);
  const tauriConfRaw = await readFile(tauriConfUrl, 'utf8');
  const tauriConf = JSON.parse(tauriConfRaw);
  tauriConf.version = version;
  targets.push({
    rel: 'apps/desktop/src-tauri/tauri.conf.json',
    url: tauriConfUrl,
    current: tauriConfRaw,
    next: `${JSON.stringify(tauriConf, null, 2)}\n`,
  });

  const desktopLockUrl = new URL('apps/desktop/src-tauri/Cargo.lock', rootUrl);
  const desktopLock = await readFile(desktopLockUrl, 'utf8');
  targets.push({
    rel: 'apps/desktop/src-tauri/Cargo.lock',
    url: desktopLockUrl,
    current: desktopLock,
    next: replaceLockPackageVersions(desktopLock, ['mizar-desktop'], version),
  });

  const installerLockUrl = new URL('apps/desktop/installer/Cargo.lock', rootUrl);
  const installerLock = await readFile(installerLockUrl, 'utf8');
  targets.push({
    rel: 'apps/desktop/installer/Cargo.lock',
    url: installerLockUrl,
    current: installerLock,
    next: replaceLockPackageVersions(
      installerLock,
      ['mizar-common', 'mizar-launcher', 'mizar-applier'],
      version,
    ),
  });

  if (stablePattern.test(version)) {
    const updateReleaseUrl = new URL('scripts/qualification/update-release.json', rootUrl);
    const updateReleaseRaw = await readFile(updateReleaseUrl, 'utf8');
    const updateRelease = JSON.parse(updateReleaseRaw);
    updateRelease.version = version;
    targets.push({
      rel: 'scripts/qualification/update-release.json',
      url: updateReleaseUrl,
      current: updateReleaseRaw,
      next: `${JSON.stringify(updateRelease, null, 2)}\n`,
    });
  }

  const changed = targets.filter((item) => item.next !== item.current);
  if (dryRun) {
    log(`[dry-run] 准备版本 ${version}（${promoted ? '提升 Unreleased 日志' : '沿用现有日志'}）`);
    for (const item of changed) log(`  将更新：${item.rel}`);
    return { dryRun: true, version, promoted, changedPaths: changed.map((item) => item.rel) };
  }

  for (const item of changed) {
    await writeFile(item.url, item.next, 'utf8');
  }

  const verifiedVersion = await readAppVersion(rootUrl);
  if (verifiedVersion !== version) {
    throw new Error(`版本自检失败：期望 ${version}，实际 ${verifiedVersion}`);
  }
  checkReleaseNotes(await readFile(changelogPath, 'utf8'), version);
  log(`已准备版本 ${version}（更新 ${changed.length} 个文件，版本与更新日志自检通过）`);
  return { dryRun: false, version, promoted, changedPaths: changed.map((item) => item.rel) };
}

function parseCliArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  let version;
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('-') && !version) {
      version = arg;
    } else {
      throw new Error('用法：pnpm release:prepare <version> [--dry-run]');
    }
  }
  return { version, dryRun };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, dryRun } = parseCliArgs(process.argv.slice(2));
  await prepareRelease(version, { dryRun });
}
