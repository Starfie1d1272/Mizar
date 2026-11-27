import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import {
  HOST_CARGO_PACKAGES,
  INSTALLER_CARGO_PACKAGES,
  readAppVersion,
  replaceLockPackageVersions,
  replaceTomlSectionVersion,
  validateReleaseTag,
} from './app-version.mjs';
import { checkReleaseNotes } from './check-release-notes.mjs';
import { releaseSections } from './release-notes.mjs';

const stablePattern = /^\d+\.\d+\.\d+$/;

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

  const changelogUrl = new URL('CHANGELOG.md', rootUrl);
  const currentChangelog = await readFile(changelogUrl, 'utf8');
  const { nextChangelog, promoted, hasPrerelease } = promoteUnreleasedChangelog(
    currentChangelog,
    version,
  );
  if (hasPrerelease) {
    log(`提醒：检测到 ${version} 的预发布章节，请确认正式版日志已汇总期间 RC 的累计变更。`);
  }

  const fileSpecs = [
    {
      rel: 'CHANGELOG.md',
      current: currentChangelog,
      transform: () => nextChangelog,
    },
    {
      rel: 'apps/desktop/src-tauri/Cargo.toml',
      transform: (text) => replaceTomlSectionVersion(text, 'package', version),
    },
    {
      rel: 'apps/desktop/installer/Cargo.toml',
      transform: (text) => replaceTomlSectionVersion(text, 'workspace.package', version),
    },
    {
      rel: 'apps/desktop/src-tauri/tauri.conf.json',
      transform: (text) => `${JSON.stringify({ ...JSON.parse(text), version }, null, 2)}\n`,
    },
    {
      rel: 'apps/desktop/src-tauri/Cargo.lock',
      transform: (text) => replaceLockPackageVersions(text, HOST_CARGO_PACKAGES, version),
    },
    {
      rel: 'apps/desktop/installer/Cargo.lock',
      transform: (text) => replaceLockPackageVersions(text, INSTALLER_CARGO_PACKAGES, version),
    },
    ...(stablePattern.test(version)
      ? [
          {
            rel: 'scripts/qualification/update-release.json',
            transform: (text) => `${JSON.stringify({ ...JSON.parse(text), version }, null, 2)}\n`,
          },
        ]
      : []),
  ];

  const targets = await Promise.all(
    fileSpecs.map(async ({ rel, current, transform }) => {
      const url = new URL(rel, rootUrl);
      const before = current ?? (await readFile(url, 'utf8'));
      return { rel, url, current: before, next: transform(before) };
    }),
  );

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
  checkReleaseNotes(await readFile(changelogUrl, 'utf8'), version);
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
