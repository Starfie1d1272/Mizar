import { spawn } from 'node:child_process';
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
function child(lane, root, result) {
  return new Promise((resolvePromise, reject) => {
    const processChild = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'worker', lane, root, result],
      { stdio: 'inherit', env: process.env },
    );
    processChild.once('error', reject);
    processChild.once('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`Box lane failed: ${lane}`)),
    );
  });
}
export async function runLanes(planRoot, workRoot, receiptsRoot, run = child) {
  await mkdir(workRoot, { recursive: false });
  await mkdir(receiptsRoot, { recursive: false });
  const results = await Promise.allSettled(
    lanes.map(async (lane) => {
      const root = join(workRoot, lane),
        result = join(workRoot, `${lane}-result.json`);
      await cp(planRoot, root, { recursive: true, force: false, errorOnExist: true });
      await run(lane, root, result);
    }),
  );
  const recovery = [];
  for (const lane of lanes) {
    try {
      const value = JSON.parse(
        await readFile(join(workRoot, `${lane}-result.json`), 'utf8'),
      ).recovery;
      if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
        recovery.push(value);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (process.env.GITHUB_OUTPUT && recovery.length)
    await appendFile(process.env.GITHUB_OUTPUT, `recovery_started_at=${recovery.sort()[0]}\n`);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Box lane failed; all lanes have settled');
  for (const lane of lanes)
    await copyFile(
      join(workRoot, lane, 'receipt', `${lane}.json`),
      join(receiptsRoot, `${lane}.json`),
      1,
    );
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
