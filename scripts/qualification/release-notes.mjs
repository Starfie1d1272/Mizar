import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/;

// Deliberately bounded authoring format, rather than a general Markdown renderer.
// The same parsed release feeds GitHub Markdown and the signed plain-text notes.
export function releaseSection(changelog, version) {
  if (!versionPattern.test(version)) throw new Error('更新日志版本无效');
  const sections = new Map();
  let current;
  for (const line of changelog.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      const heading = /^## \[(.+)\]$/.exec(line);
      if (!heading || (!versionPattern.test(heading[1]) && heading[1] !== 'Unreleased'))
        throw new Error('版本标题须为 ## [版本号] 或 ## [Unreleased]');
      current = heading[1];
      if (sections.has(current)) throw new Error('更新日志版本重复');
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
  }
  const markdown = sections
    .get(version)
    ?.join('\n')
    .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
  if (!markdown?.trim()) throw new Error(`更新日志缺少 ${version} 的正文`);
  const blocks = parseReleaseMarkdown(markdown);
  return {
    version,
    markdown,
    text: blocks
      .map((block) => block.text)
      .join('\n')
      .trim(),
  };
}

function inlineText(value) {
  let output = '';
  for (let index = 0; index < value.length;) {
    const char = value[index];
    if (char === '`' || char === '*') {
      const marker = value.startsWith('**', index) ? '**' : char;
      const end = value.indexOf(marker, index + marker.length);
      if (end <= index + marker.length) throw new Error('更新日志行内格式未闭合');
      const content = value.slice(index + marker.length, end);
      if (marker === '`') {
        if (content.includes('`')) throw new Error('更新日志仅支持单反引号行内代码');
        output += content;
      } else output += inlineText(content);
      index = end + marker.length;
    } else if (char === '[') {
      const labelEnd = value.indexOf('](', index + 1);
      const end = value.indexOf(')', labelEnd + 2);
      if (labelEnd < 0 || end < 0) throw new Error('更新日志链接格式无效');
      const address = value.slice(labelEnd + 2, end);
      if (!/^https:\/\/[^\s<>]+$/.test(address)) throw new Error('更新日志链接仅支持 HTTPS 地址');
      const label = value.slice(index + 1, labelEnd);
      if (!label) throw new Error('更新日志链接文字为空');
      output += inlineText(label);
      index = end + 1;
    } else {
      if ('<>!\\'.includes(char) || char === ']')
        throw new Error('更新日志不支持 HTML、图片或转义语法');
      output += char;
      index++;
    }
  }
  return output;
}

export function parseReleaseMarkdown(markdown) {
  return markdown.split('\n').map((line) => {
    if (!line.trim()) return { kind: 'blank', text: '' };
    if (/^### [^#]/.test(line)) return { kind: 'heading', text: inlineText(line.slice(4)) };
    const bullet = /^( {0,4})- (\S.*)$/.exec(line);
    if (bullet && bullet[1].length % 2 === 0)
      return { kind: 'bullet', text: `${bullet[1]}• ${inlineText(bullet[2])}` };
    const numbered = /^(\d+)\. (\S.*)$/.exec(line);
    if (numbered) return { kind: 'paragraph', text: `${numbered[1]}. ${inlineText(numbered[2])}` };
    if (/^[\s#>|~+-]/.test(line) || line.includes('|') || line.includes('```'))
      throw new Error('更新日志仅支持三级标题、段落、列表及简单行内格式');
    return { kind: 'paragraph', text: inlineText(line) };
  });
}

export async function readReleaseNotes(version) {
  return releaseSection(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), version);
}

export function githubReleaseNotes(notes, { sourceSha, qualificationRunId }) {
  if (
    !versionPattern.test(notes.version) ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[1-9]\d*$/.test(String(qualificationRunId))
  )
    throw new Error('发布说明构建身份无效');
  const repo = 'https://github.com/Starfie1d1272/Mizar';
  const tag = `v${notes.version}`;
  const box = 'https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/';
  const download = `${repo}/releases/download/${tag}/Mizar-${tag}-Windows-x64`;
  return (
    `# Mizar ${notes.version}\n\n` +
    `**Windows 安装器**：[GitHub](${download}-Setup.exe) · [Box 国内入口](${box})\n\n` +
    `**完整离线 ZIP**：[GitHub](${download}.zip) · [Box 国内入口](${box})\n\n` +
    `Box 同步可能稍晚，请以版本号为准。[安装与使用手册](${repo}/blob/${sourceSha}/docs/guide/quick-start.md)。\n\n` +
    `${notes.markdown}\n\n## 发行文件\n\n` +
    `下方 Assets 提供两种产品下载。原始清单、校验与签名证明、验收记录合并在持久证据 ZIP；更新与资源资料供程序验证，NSIS 许可原文随对应版本保留。\n\n` +
    `安装包尚无 Windows 发布者代码签名。\n\n## 构建与校验\n\n` +
    `源码：${sourceSha}\n\n[资格构建](${repo}/actions/runs/${qualificationRunId})。发布资产沿用该构建的已验证文件。\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , version, sourceSha, qualificationRunId, output] = process.argv;
  if (!output) throw new Error('用法：release-notes.mjs 版本 源码SHA 资格任务ID 输出文件');
  await writeFile(
    output,
    githubReleaseNotes(await readReleaseNotes(version), {
      sourceSha,
      qualificationRunId,
    }),
    'utf8',
  );
}
