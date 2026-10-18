import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parsers } from 'prettier/plugins/yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Use the existing formatter's YAML parser, without introducing a second workflow config.
function value(node) {
  if (node.type === 'mapping')
    return Object.fromEntries(node.children.map((item) => item.children.map(value)));
  if (['sequence', 'flowSequence'].includes(node.type)) return node.children.map(value);
  if (typeof node.value === 'string') return node.value;
  if (node.children?.length === 1) return value(node.children[0]);
  throw new Error(`Unsupported workflow fixture node: ${node.type}`);
}
const ast = await parsers.yaml.parse(
  await readFile(join(root, '.github/workflows/box-sync.yml'), 'utf8'),
);
const workflow = value(ast.children[0].children.find((node) => node.type === 'documentBody'));
const job = workflow.jobs.sync;
const mirrorIndex = job.steps.findIndex((step) => step.id === 'mirror');
const mirror = job.steps[mirrorIndex];
const followups = job.steps.slice(mirrorIndex + 1);
const evaluate = (expression, context) =>
  runInNewContext(expression.replace(/^\$\{\{|\}\}$/g, '').trim(), context, { timeout: 1000 });
function context(event, tag, mode) {
  return {
    github: {
      repository: 'Starfie1d1272/Mizar',
      token: 'fixture',
      event_name: event,
      event: {
        workflow_run: {
          id: 123,
          conclusion: 'success',
          path: '.github/workflows/release-promotion.yml',
          event: 'workflow_dispatch',
        },
      },
    },
    inputs: event === 'workflow_dispatch' ? { tag, mode } : {},
    secrets: { MIZAR_BOX_REPO_TOKEN: '' },
  };
}
async function mirrorOutput(ctx, tag) {
  const folder = await mkdtemp(join(tmpdir(), 'mizar-box-workflow-'));
  try {
    const eventPath = join(folder, 'event.json');
    const outputPath = join(folder, 'output');
    await writeFile(eventPath, JSON.stringify(ctx.github.event));
    await writeFile(outputPath, '');
    const env = Object.fromEntries(
      Object.entries(mirror.env).map(([key, entry]) => [
        key,
        entry.startsWith('${{') ? String(evaluate(entry, ctx)) : entry,
      ]),
    );
    const command = /^node (\S+)$/.exec(mirror.run);
    expect(command).not.toBeNull();
    const script = join(root, command[1]);
    const run = {
      ...ctx.github.event.workflow_run,
      repository: { full_name: ctx.github.repository },
    };
    const jobs = {
      jobs: [
        { run_id: 123, status: 'completed', conclusion: 'success', name: `发布 Mizar ${tag}` },
      ],
    };
    const responses =
      ctx.github.event_name === 'workflow_run'
        ? {
            'https://api.github.com/repos/Starfie1d1272/Mizar/actions/runs/123': run,
            'https://api.github.com/repos/Starfie1d1272/Mizar/actions/runs/123/jobs?per_page=100':
              jobs,
          }
        : {};
    // Real CLI and environment from the checked-in workflow; allow only automatic
    // trigger identity reads. No credentials, Box access, artifact downloads or writes.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const responses = ${JSON.stringify(responses)};
      globalThis.fetch = async (url, init) => {
        if (!responses[url] || (init?.method && init.method !== 'GET')) throw new Error('Unexpected network access');
        return new Response(JSON.stringify(responses[url]));
      };
      process.argv[1] = ${JSON.stringify(script)};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          GITHUB_REPOSITORY: ctx.github.repository,
          GITHUB_EVENT_NAME: ctx.github.event_name,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: '',
        },
      },
    );
    const outputs = Object.fromEntries(
      (await readFile(outputPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=')),
    );
    return { ...result, outputs };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
function enabledFollowups(ctx, outputs) {
  const stepContext = { ...ctx, steps: { [mirror.id]: { outputs } } };
  return followups.filter((step) => !step.if || evaluate(step.if, stepContext));
}

describe.each([
  ['workflow_run', 'sync'],
  ...['sync', 'probe', 'verify-downloads', 'rollback-downloads'].map((mode) => [
    'workflow_dispatch',
    mode,
  ]),
])('complete Box workflow: %s / %s', (event, mode) => {
  it.each(['alpha.1', 'beta.2', 'rc.3'])(
    'skips every downstream timing/upload step for %s',
    async (suffix) => {
      const tag = `v2.0.0-${suffix}`;
      const ctx = context(event, tag, mode);
      expect(evaluate(job.if, ctx)).toBe(true);
      const result = await mirrorOutput(ctx, tag);
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs.prerelease).toBe('true');
      expect(result.stdout).toContain('预发布版本');
      // This fails if any subsequent step loses its guard, including timing artifacts.
      expect(followups.length).toBeGreaterThanOrEqual(2);
      expect(enabledFollowups(ctx, result.outputs)).toEqual([]);
    },
  );
});
it.each(['workflow_run', 'workflow_dispatch'])(
  'preserves stable timing/upload eligibility for %s',
  async (event) => {
    const ctx = context(event, 'v1.5.0', 'sync');
    const result = await mirrorOutput(ctx, 'v1.5.0');
    // Stable continues into the original synchronization path and requires credentials.
    // No live stable operation is authorized or performed by this fixture.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未配置 MIZAR_BOX_REPO_TOKEN');
    expect(result.outputs.prerelease).toBe('false');
    expect(enabledFollowups(ctx, result.outputs)).toEqual(followups);
    expect(enabledFollowups(ctx, {})).toEqual([]);
  },
);
