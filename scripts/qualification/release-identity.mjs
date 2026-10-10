import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'Starfie1d1272/Mizar';
const MAIN_REF = 'refs/heads/main';
const QUALIFICATION_WORKFLOW = '.github/workflows/release-qualification.yml';
const PROMOTION_WORKFLOW = '.github/workflows/release-promotion.yml';
const isSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);

function assertMainWorkflow(context, checkedOutSha, workflow) {
  if (
    context.repository !== REPOSITORY ||
    context.ref !== MAIN_REF ||
    context.event !== 'workflow_dispatch' ||
    context.workflowRef !== `${REPOSITORY}/${workflow}@${MAIN_REF}` ||
    !isSha(context.sha) ||
    checkedOutSha !== context.sha
  )
    throw new Error('发布工作流必须来自 main，checkout 必须等于本次工作流源码 SHA');
}

export function assertQualificationIdentity(context, checkedOutSha, requestedSha, manifestSha) {
  assertMainWorkflow(context, checkedOutSha, QUALIFICATION_WORKFLOW);
  if (requestedSha !== context.sha || (manifestSha !== undefined && manifestSha !== context.sha))
    throw new Error('候选、请求源码与签发工作流 SHA 必须一致');
  return context.sha;
}

export function assertQualificationRun(run, sourceSha) {
  if (
    !isSha(sourceSha) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== QUALIFICATION_WORKFLOW ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.head_sha !== sourceSha
  )
    throw new Error('资格任务必须是 main 上产品精确源码的成功签发任务');
}

export function releaseAttestationArgs(file, sourceSha, bundle, workflow = 'qualification') {
  if (!isSha(sourceSha)) throw new Error('来源证明必须绑定有效产品源码 SHA');
  if (!['qualification', 'promotion'].includes(workflow)) throw new Error('非法签发工作流');
  return [
    'attestation',
    'verify',
    file,
    '--repo',
    REPOSITORY,
    '--signer-workflow',
    `${REPOSITORY}/.github/workflows/release-${workflow}.yml@${MAIN_REF}`,
    '--source-ref',
    MAIN_REF,
    '--source-digest',
    sourceSha,
    ...(bundle ? ['--bundle', bundle] : []),
  ];
}

// Independent subjects share the same fixed main identity policy; failure waits for all active verifiers.
export async function verifyReleaseAttestations(subjects, execute = promisify(execFile)) {
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('缺少待验证原始资产');
  const argumentsBySubject = subjects.map(({ file, sourceSha, bundle, workflow }) =>
    releaseAttestationArgs(file, sourceSha, bundle, workflow),
  );
  let next = 0;
  const workers = Array.from({ length: Math.min(4, subjects.length) }, async () => {
    while (next < argumentsBySubject.length) {
      const args = argumentsBySubject[next++];
      await execute('gh', args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
function workflowContext() {
  return {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'qualification' && args.length <= 1) {
    const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const manifest = args[0] ? await readJson(args[0]) : undefined;
    const sha = assertQualificationIdentity(
      workflowContext(),
      checkedOutSha,
      process.env.QUALIFICATION_SOURCE_INPUT,
      manifest?.gitSha,
    );
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
    console.log(`候选与签发身份一致：${sha}`);
  } else if (mode === 'promotion' && args.length === 2) {
    const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assertMainWorkflow(workflowContext(), checkedOutSha, PROMOTION_WORKFLOW);
    const manifest = await readJson(args[1]);
    assertQualificationRun(await readJson(args[0]), manifest.gitSha);
  } else if (mode === 'attestation' && (args.length === 2 || args.length === 4)) {
    if (args.length === 4 && args[2] !== '--bundle') throw new Error('非法证明参数');
    execFileSync('gh', releaseAttestationArgs(args[0], args[1], args[3]), { stdio: 'inherit' });
  } else if (mode === 'attestations' && args.length >= 2) {
    await verifyReleaseAttestations(args.slice(1).map((file) => ({ file, sourceSha: args[0] })));
  } else
    throw new Error(
      '用法：release-identity.mjs qualification [manifest] | promotion run manifest | attestation file SHA [--bundle file] | attestations SHA file...',
    );
}
