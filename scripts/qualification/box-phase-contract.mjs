import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const lanes = ['runtime', 'resources', 'downloads'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const encode = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
function parseCanonical(bytes) {
  requireValue(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024,
    'Invalid phase record size',
  );
  const value = JSON.parse(bytes.toString('utf8'));
  requireValue(encode(value).equals(bytes), 'Phase record is not canonical');
  return value;
}
function validateAsset(asset) {
  requireValue(
    asset &&
      Object.keys(asset).sort().join(',') === 'name,sha256,size' &&
      typeof asset.name === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(asset.name) &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0 &&
      /^[a-f0-9]{64}$/.test(asset.sha256),
    'Invalid phase asset identity',
  );
}
export function createBoxPlan({
  runId,
  attempt,
  tag,
  releaseId,
  sourceSha,
  coreArchiveSha,
  assets,
  updateIndex,
}) {
  const plan = {
    schemaVersion: 'mizar.box-plan.v1',
    runId,
    attempt,
    tag,
    releaseId,
    sourceSha,
    coreArchiveSha,
    assets,
    updateIndex,
  };
  validateBoxPlan(plan);
  return encode(plan);
}
export function validateBoxPlan(plan) {
  requireValue(
    plan &&
      Object.keys(plan).sort().join(',') ===
        'assets,attempt,coreArchiveSha,releaseId,runId,schemaVersion,sourceSha,tag,updateIndex' &&
      plan.schemaVersion === 'mizar.box-plan.v1' &&
      /^\d+$/.test(plan.runId) &&
      Number.isSafeInteger(plan.attempt) &&
      plan.attempt > 0 &&
      /^v\d+\.\d+\.\d+$/.test(plan.tag) &&
      Number.isSafeInteger(plan.releaseId) &&
      plan.releaseId > 0 &&
      /^[a-f0-9]{40}$/.test(plan.sourceSha) &&
      /^[a-f0-9]{64}$/.test(plan.coreArchiveSha) &&
      plan.assets &&
      Object.keys(plan.assets).sort().join(',') === lanes.slice().sort().join(','),
    'Invalid Box plan identity',
  );
  const names = new Set();
  for (const lane of lanes) {
    requireValue(
      Array.isArray(plan.assets[lane]) &&
        plan.assets[lane].length > 0 &&
        plan.assets[lane].length <= 16,
      'Invalid Box plan lane',
    );
    for (const asset of plan.assets[lane]) {
      validateAsset(asset);
      requireValue(!names.has(asset.name), 'Duplicate Box plan asset');
      names.add(asset.name);
    }
  }
  requireValue(
    plan.assets.runtime.length === 2 &&
      plan.assets.runtime.some((item) => item.name === 'machine-metadata.json') &&
      plan.assets.runtime.some(
        (item) => item.name === `Mizar-${plan.tag}-Windows-x64-Core-Setup.exe`,
      ) &&
      plan.assets.resources.length === 1 &&
      /^Mizar-official-epl-default-\d+\.\d+\.\d+\.zip$/.test(plan.assets.resources[0].name) &&
      plan.assets.downloads.length === 1 &&
      plan.assets.downloads[0].name === `Mizar-${plan.tag}-Windows-x64-WebInstaller.exe`,
    'Invalid Box lane inventory',
  );
  validateAsset(plan.updateIndex);
  requireValue(plan.updateIndex.name === 'update-index.json', 'Invalid Box plan update index');
  return plan;
}
export const readBoxPlan = (bytes) => validateBoxPlan(parseCanonical(bytes));
export function makeBoxReceipt(planBytes, lane, runId, attempt, assets) {
  const plan = readBoxPlan(planBytes);
  requireValue(
    lanes.includes(lane) &&
      runId === plan.runId &&
      Number.isSafeInteger(attempt) &&
      attempt >= plan.attempt,
    'Invalid phase receipt context',
  );
  requireValue(
    encode(assets).equals(encode(plan.assets[lane])),
    'Phase receipt asset identity differs',
  );
  return encode({
    schemaVersion: 'mizar.box-receipt.v1',
    planSha256: digest(planBytes),
    runId,
    planAttempt: plan.attempt,
    attempt,
    lane,
    assets,
  });
}
export function assertBoxReceipt(planBytes, receiptBytes, lane, runId, currentAttempt) {
  const plan = readBoxPlan(planBytes);
  const receipt = parseCanonical(receiptBytes);
  requireValue(
    receipt &&
      Object.keys(receipt).sort().join(',') ===
        'assets,attempt,lane,planAttempt,planSha256,runId,schemaVersion' &&
      receipt.schemaVersion === 'mizar.box-receipt.v1' &&
      receipt.planSha256 === digest(planBytes) &&
      receipt.runId === runId &&
      runId === plan.runId &&
      receipt.planAttempt === plan.attempt &&
      Number.isSafeInteger(receipt.attempt) &&
      receipt.attempt >= plan.attempt &&
      receipt.attempt <= currentAttempt &&
      receipt.lane === lane &&
      lanes.includes(lane) &&
      encode(receipt.assets).equals(encode(plan.assets[lane])),
    'Invalid Box phase receipt',
  );
  return receipt;
}
