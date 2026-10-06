import { loadBundledMap } from 'cs2-c4-damage/node';
import { prepareBombDamage } from '@mizar/core/projection';
import { BombDamageWorkerClient } from './bomb-damage-worker-client.js';
import { performance } from 'node:perf_hooks';
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function measure(task: () => unknown) {
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
  }, 5);
  await wait(20);
  const start = performance.now();
  await task();
  const durationMs = performance.now() - start;
  await wait(20);
  clearInterval(timer);
  return { durationMs, maxGapMs, ticks };
}
export async function probeC4Worker() {
  const rows = [];
  const worker = new BombDamageWorkerClient(() => {});
  try {
    for (const mapName of ['de_ancient', 'de_inferno', 'de_mirage']) {
      const direct = await measure(async () => prepareBombDamage(await loadBundledMap(mapName)));
      const isolated = await measure(() => worker.load(mapName));
      rows.push({ mapName, direct, worker: isolated });
      worker.evict(mapName);
    }
  } finally {
    worker.close();
  }
  const report = {
    schemaVersion: 1,
    evidence: 'module-probe',
    node: process.version,
    platform: process.platform,
    rows,
  };
  return report;
}
