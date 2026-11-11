import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { readAppVersion } from './app-version.mjs';
import { parseReleaseMarkdown, releaseSections } from './release-notes.mjs';

const categories = ['新增功能', '体验改进', '问题修复', '升级提醒'];

export function checkReleaseNotes(changelog, appVersion) {
  const sections = releaseSections(changelog);
  if (!sections.has(appVersion)) throw new Error(`更新日志缺少 ${appVersion} 的正文`);
  for (const [version, markdown] of sections) {
    try {
      if (!markdown.trim()) {
        if (version === 'Unreleased') continue;
        throw new Error('版本正文为空');
      }
      const blocks = parseReleaseMarkdown(markdown);
      if (version !== appVersion && version !== 'Unreleased') continue;
      let previous = -1;
      let hasContent = false;
      for (const block of blocks) {
        if (block.kind === 'heading') {
          if (previous >= 0 && !hasContent) throw new Error(`分类「${categories[previous]}」为空`);
          const index = categories.indexOf(block.text);
          if (index < 0) throw new Error(`未知分类「${block.text}」`);
          if (index <= previous) throw new Error(`分类「${block.text}」重复或顺序错误`);
          previous = index;
          hasContent = false;
        } else if (block.kind !== 'blank' && previous >= 0) hasContent = true;
      }
      if (previous < 0) throw new Error('正文须按新增功能、体验改进、问题修复、升级提醒分类');
      if (!hasContent) throw new Error(`分类「${categories[previous]}」为空`);
    } catch (error) {
      throw new Error(`${version}: ${error.message}`, { cause: error });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkReleaseNotes(
    await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
    await readAppVersion(),
  );
  console.log('更新日志格式与当前版本分类检查通过');
}
