import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import { releaseSection, githubReleaseNotes } from './release-notes.mjs';
import { qualifiedUpdateManifest } from './update-manifest.mjs';

const example = `# 更新日志

## [Unreleased]

尚未发布。

## [2.3.0]

### 改进

- 查看 **更新日志**，保留 *选手昵称*。
  - 使用 \`Mizar.exe\`。
    - 阅读 [操作手册](https://example.com/guide)。

### 升级说明

1. 退出 Mizar。
2. 安装新版。

## [2.2.0]

旧版内容。
`;

it('selects only the exact release and preserves readable structure without Markdown markers', () => {
  const release = releaseSection(example.replaceAll('\n', '\r\n'), '2.3.0');
  expect(release.text).toBe(`改进

• 查看 更新日志，保留 选手昵称。
  • 使用 Mizar.exe。
    • 阅读 操作手册。

升级说明

1. 退出 Mizar。
2. 安装新版。`);
  expect(release.markdown).toContain('**更新日志**');
  expect(release.markdown).not.toContain('旧版内容');
  expect(releaseSection(example.replace('[2.3.0]', '[2.3.0-rc.1]'), '2.3.0-rc.1').text).toContain(
    '改进',
  );
});

it('refuses missing, duplicate, empty or malformed releases and unsupported authoring', () => {
  for (const document of [
    example.replace('[2.3.0]', '[2.3.1]'),
    `${example}\n## [2.3.0]\n重复内容`,
    '# 更新日志\n## [2.3.0]\n\n## [2.2.0]\n旧版',
    example.replace('## [2.3.0]', '## 2.3.0'),
    ...[
      '| 列 | 表 |',
      '> 引用',
      '```js\ncode\n```',
      '<b>HTML</b>',
      '![图片](https://example.com/a.png)',
      '#### 四级标题',
      '- **未闭合',
      '- [相对链接](../guide.md)',
      '   - 错误缩进',
    ].map((body) => `## [2.3.0]\n${body}`),
  ])
    expect(() => releaseSection(document, '2.3.0')).toThrow();
  expect(() => releaseSection(example, '../2.3.0')).toThrow();
});

it('builds fixed GitHub framing from the same release with exact asset and evidence links', () => {
  const body = githubReleaseNotes(releaseSection(example, '2.3.0'), {
    sourceSha: 'a'.repeat(40),
    qualificationRunId: '12345',
  });
  expect(body).toContain('/releases/download/v2.3.0/Mizar-v2.3.0-Windows-x64-WebInstaller.exe');
  expect(body).toContain('/releases/download/v2.3.0/Mizar-v2.3.0-Windows-x64.zip');
  expect(body).toContain(`/blob/${'a'.repeat(40)}/docs/guide/quick-start.md`);
  expect(body).toContain('**更新日志**');
  expect(body).toContain('## 发行文件');
  expect(body.match(/https:\/\/box\.nju\.edu\.cn\/d\/91dec4c27e5d47f38fcf\//g)).toHaveLength(2);
  expect(body).toContain('Box 同步可能稍晚，请以版本号为准');
  expect(body).toContain('完整离线 ZIP');
  expect(body).not.toMatch(/Box 已|已同步|云盘已/);
  expect(body).toContain('/actions/runs/12345');
  expect(body).not.toContain('尚未发布');
  expect(() =>
    githubReleaseNotes(releaseSection(example, '2.3.0'), {
      sourceSha: 'main',
      qualificationRunId: '12345',
    }),
  ).toThrow();
});

it('embeds the repository release as plain text in the qualified update manifest', async () => {
  const policy = JSON.parse(
    await readFile(new URL('./update-release.json', import.meta.url), 'utf8'),
  );
  const directory = await mkdtemp(join(tmpdir(), 'mizar-release-notes-'));
  const identity = {
    appVersion: policy.version,
    gitSha: 'a'.repeat(40),
    contentDigest: 'b'.repeat(64),
    archiveSha256: 'c'.repeat(64),
    developmentOnly: false,
    desktopBuildProfile: 'release',
  };
  try {
    await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(identity));
    await writeFile(
      join(directory, 'distribution-manifest.json'),
      JSON.stringify({
        ...identity,
        originalArchiveSha256: identity.archiveSha256,
        format: 'nsis-setup',
        archive: `Mizar-v${policy.version}-Windows-x64-Setup.exe`,
        archiveBytes: 1234,
      }),
    );
    const manifest = await qualifiedUpdateManifest(directory);
    expect(manifest.notes).toMatch(/^应用内更新\n\n• 新增/);
    expect(manifest.notes).toContain('自动检查默认关闭');
    expect(manifest.notes).not.toMatch(/###|\]\(|\*\*/);
    expect(manifest.gitSha).toBe(identity.gitSha);
    expect(manifest.installer.sha256).toBe(identity.archiveSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
