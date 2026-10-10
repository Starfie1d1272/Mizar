import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const installerCases = Object.freeze({
  update: [
    'pending-marker',
    'prepared-install',
    'destination-selection',
    'same-version-update',
    'ambiguous-launch',
    'prepared-recovery',
    'update-rollback',
  ],
  faults: [
    'historical-bridge',
    'app-resource-boundary',
    'unknown-existing-files',
    'completed-pending',
    'owned-residue',
    'post-install-identity',
    'cancelled-install',
    'invalid-installer',
  ],
});

export function verifyInstallerShards(root, { attempt, runId, sourceSha }) {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !/^[1-9][0-9]*$/.test(runId) ||
    !/^[a-f0-9]{40}$/.test(sourceSha)
  )
    throw new Error('invalid installer evidence identity');
  const selected = new Map();
  for (const name of readdirSync(root)) {
    const match = /^installer-evidence-([1-9][0-9]*)-(update|faults)$/.exec(name);
    if (!match || Number(match[1]) > attempt)
      throw new Error('unknown or future installer evidence');
    const generation = Number(match[1]),
      group = match[2];
    if (!selected.has(group) || selected.get(group).generation < generation)
      selected.set(group, { generation, name });
  }
  let count = 0;
  for (const [group, expected] of Object.entries(installerCases)) {
    const entry = selected.get(group);
    if (!entry) throw new Error('missing installer group: ' + group);
    const record = JSON.parse(readFileSync(join(root, entry.name, 'nsis-evidence.json'), 'utf8'));
    if (
      record.group !== group ||
      record.runId !== runId ||
      record.sourceSha !== sourceSha ||
      record.attempt !== String(entry.generation)
    )
      throw new Error('installer evidence identity mismatch');
    if (
      !Array.isArray(record.cases) ||
      record.cases.length !== expected.length ||
      new Set(record.cases).size !== expected.length ||
      expected.some((name) => !record.cases.includes(name))
    )
      throw new Error('installer case coverage mismatch: ' + group);
    count += record.cases.length;
  }
  return { groups: selected.size, passed: count };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify(
      verifyInstallerShards(process.argv[2], {
        attempt: Number(process.argv[3]),
        runId: process.env.GITHUB_RUN_ID,
        sourceSha: process.env.GITHUB_SHA,
      }),
    ),
  );
}
