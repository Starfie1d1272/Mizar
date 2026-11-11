import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = ['windows', 'installer', 'defender', 'cs2', 'obs'];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function note(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
}

export function verifyReleaseAcceptance(record, expected, now = Date.now()) {
  requireValue(record && typeof record === 'object', 'Missing field acceptance');
  for (const [key, value] of Object.entries(expected))
    requireValue(record[key] === value, `Field acceptance identity mismatch: ${key}`);

  const hotfix = record.mode === 'hotfix';
  requireValue(hotfix || record.mode === 'standard', 'Invalid release acceptance mode');
  let deferred = false;
  for (const key of required) {
    const check = record.checks?.[key];
    if (check?.status === 'passed' && note(check.evidence)) continue;
    if (['cs2', 'obs'].includes(key) && check?.status === 'not_applicable' && note(check.reason))
      continue;
    if (hotfix && check?.status === 'deferred' && note(check.reason)) {
      deferred = true;
      continue;
    }
    throw new Error(`Field acceptance is incomplete: ${key}`);
  }
  if (hotfix) {
    requireValue(note(record.reason), 'Hotfix requires an explicit reason');
    if (deferred)
      requireValue(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.recheckBy) &&
          Date.parse(record.recheckBy) > now,
        'Deferred checks require a future UTC recheck deadline',
      );
  }
  return record;
}

function github(repo, path) {
  const output = execFileSync('gh', ['api', `repos/${repo}/${path}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 256 * 1024,
  });
  return JSON.parse(output);
}

async function fromComment(repo, commentId, product, runId) {
  requireValue(/^\d+$/.test(commentId), 'Provide the numeric ID of the field acceptance comment');
  const comment = github(repo, `issues/comments/${commentId}`);
  requireValue(
    comment.user?.type === 'User' &&
      /^[A-Za-z0-9-]+$/.test(comment.user.login) &&
      comment.issue_url?.startsWith(`https://api.github.com/repos/${repo}/issues/`) &&
      comment.html_url?.startsWith(`https://github.com/${repo}/issues/`),
    'Field acceptance must be recorded by a repository maintainer',
  );
  if (comment.author_association !== 'OWNER') {
    const access = github(repo, `collaborators/${comment.user.login}/permission`);
    requireValue(
      ['admin', 'maintain'].includes(access.permission) ||
        ['admin', 'maintain'].includes(access.role_name),
      'Field acceptance author lacks maintenance permission',
    );
  }
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json'), 'utf8'));
  const installer = JSON.parse(await readFile(join(product, 'web-installer-build.json'), 'utf8'));
  const [fullSetup, coreSetup] = await Promise.all(
    ['distribution-manifest.json', 'core-distribution-manifest.json'].map(async (name) =>
      JSON.parse(await readFile(join(product, name), 'utf8')),
    ),
  );
  const json = /^```json\r?\n([\s\S]+)\r?\n```$/.exec(comment.body?.trim())?.[1];
  requireValue(
    json && json.length <= 12000,
    'Field acceptance comment must contain one JSON block',
  );
  const record = verifyReleaseAcceptance(JSON.parse(json), {
    qualificationRun: runId,
    gitSha: manifest.gitSha,
    archiveSha256: manifest.archiveSha256,
    webInstallerSha256: installer.sha256,
    fullSetupSha256: fullSetup.archiveSha256,
    coreSetupSha256: coreSetup.archiveSha256,
  });
  return {
    ...record,
    commentUrl: comment.html_url,
    author: comment.user.login,
    commentUpdatedAt: comment.updated_at,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, commentId, product, runId, output] = process.argv.slice(2);
  try {
    const record = await fromComment(repo, commentId, product, runId);
    await writeFile(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    // GitHub CLI stderr is captured and can contain sensitive request details.
    console.error(error.status ? 'Field acceptance GitHub lookup failed' : error.message);
    process.exitCode = 1;
  }
}
