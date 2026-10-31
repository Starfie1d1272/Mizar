import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { appendFile, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boxPhaseDiagnostic,
  downloadLane,
  transferLane,
  transferVerifiedRuntime,
  verifyLane,
} from './box-phases.mjs';
import { getBoxRecoveryStartedAt } from './box-sync.mjs';

const lanes = ['runtime', 'resources', 'downloads'];
export async function runWorker(
  lane,
  root,
  operations = { downloadLane, transferLane, transferVerifiedRuntime, verifyLane },
) {
  if (!lanes.includes(lane)) throw new Error('Unknown Box lane');
  let phase = 'download',
    selected;
  try {
    if (lane === 'runtime') {
      selected = 'metadata';
      await operations.downloadLane(root, lane, selected);
      selected = 'core';
      await operations.downloadLane(root, lane, selected);
      phase = 'transfer-verified-runtime';
      selected = 'metadata';
      await operations.transferVerifiedRuntime(root, selected);
      selected = 'core';
      await operations.transferVerifiedRuntime(root, selected);
    } else {
      await operations.downloadLane(root, lane);
      phase = 'transfer';
      await operations.transferLane(root, lane);
      phase = 'verify';
      await operations.verifyLane(root, lane);
    }
  } catch (error) {
    console.error(boxPhaseDiagnostic(phase, lane, selected, error));
    throw new Error(`Box lane failed: ${lane}`, { cause: error });
  }
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    console.error('A process group could not be signalled or checked; termination is unknown.');
    return true;
  }
}
async function stopRemainingGroup(pid) {
  signalGroup(pid, 'SIGTERM');
  await delay(2000);
  signalGroup(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!signalGroup(pid, 0)) return;
    await delay(100);
  }
  console.error('A terminated process group remains observable; termination cannot be confirmed.');
}
function child(lane, root, result, control) {
  return control.start(process.execPath, [
    fileURLToPath(import.meta.url),
    'worker',
    lane,
    root,
    result,
  ]);
}
export async function runLanes(planRoot, workRoot, receiptsRoot, run = child) {
  const groups = new Set();
  let cancelled = false,
    cancellationWait;
  const control = {
    start(command, args) {
      if (cancelled) return Promise.reject(new Error('Box operation cancelled'));
      return new Promise((resolvePromise, reject) => {
        const worker = spawn(command, args, { stdio: 'inherit', env: process.env, detached: true });
        if (worker.pid) groups.add(worker.pid);
        worker.once('error', reject);
        worker.once('close', async (code) => {
          try {
            const remaining = worker.pid && signalGroup(worker.pid, 0);
            if (remaining && !cancelled) {
              console.error(
                'A lane exited with remaining processes; remote writes require reconciliation.',
              );
              await stopRemainingGroup(worker.pid);
            }
            if (!cancelled) groups.delete(worker.pid);
            if (code === 0 && !remaining && !cancelled) resolvePromise();
            else reject(new Error('Box lane failed or left remaining processes'));
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    console.error(
      'Box cancelled; in-flight server writes have unknown outcomes and require remote reconciliation.',
    );
    for (const pid of groups) signalGroup(pid, 'SIGTERM');
    cancellationWait = (async () => {
      await delay(2000);
      for (const pid of groups) signalGroup(pid, 'SIGKILL');
      for (let attempt = 0; attempt < 30; attempt++) {
        if (![...groups].some((pid) => signalGroup(pid, 0))) return;
        await delay(100);
      }
      console.error(
        'Some terminated process groups remain observable; termination cannot be confirmed.',
      );
    })();
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    await mkdir(workRoot, { recursive: false });
    await mkdir(receiptsRoot, { recursive: false });
    const results = await Promise.allSettled(
      lanes.map(async (lane) => {
        const root = join(workRoot, lane),
          result = join(workRoot, `${lane}-result.json`);
        await cp(planRoot, root, { recursive: true, force: false, errorOnExist: true });
        if (cancelled) throw new Error('Box operation cancelled');
        await run(lane, root, result, control);
      }),
    );
    if (cancellationWait) await cancellationWait;
    const recovery = [];
    const summary = {
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      cancelled,
      lanes: {},
    };
    for (const [index, lane] of lanes.entries()) {
      let value;
      try {
        value = JSON.parse(await readFile(join(workRoot, `${lane}-result.json`), 'utf8')).recovery;
        if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
          recovery.push(value);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      summary.lanes[lane] = {
        status: results[index].status === 'fulfilled' && !cancelled ? 'success' : 'unknown',
        ...(recovery.includes(value) ? { recovery: value } : {}),
      };
      try {
        await copyFile(
          join(workRoot, lane, 'receipt', `${lane}.json`),
          join(receiptsRoot, `${lane}.json`),
          1,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await writeFile(join(workRoot, 'orchestration.json'), JSON.stringify(summary), {
      flag: 'wx',
      mode: 0o600,
    });
    if (process.env.GITHUB_OUTPUT && recovery.length)
      await appendFile(process.env.GITHUB_OUTPUT, `recovery_started_at=${recovery.sort()[0]}\n`);
    if (cancelled || results.some((result) => result.status === 'rejected'))
      throw new Error('Box lane failed or cancelled; all lanes have settled');
    for (const lane of lanes) await readFile(join(receiptsRoot, `${lane}.json`));
  } finally {
    if (cancellationWait) await cancellationWait;
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
  if (cancelled) throw new Error('Box operation cancelled; remote writes require reconciliation');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'worker') {
    try {
      await runWorker(args[0], args[1]);
    } catch {
      process.exitCode = 1;
    } finally {
      await writeFile(args[2], JSON.stringify({ recovery: getBoxRecoveryStartedAt() }), {
        flag: 'wx',
        mode: 0o600,
      });
    }
  } else if (mode === 'run') await runLanes(...args);
  else throw new Error('Unknown Box orchestration mode');
}
