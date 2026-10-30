import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_BUILD_PHASES = [
  'workspace-build',
  'deploy-production-dependencies',
  'node-runtime',
  'observer-component',
  'mulnx-bundle',
  'desktop-cargo-build',
  'content-digest',
  'payload-checksums',
  'zip-archive',
];

export function validBuildTiming(value, sourceSha) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.measurementUnavailable === true ||
    !/^[a-f0-9]{40}$/.test(sourceSha ?? '') ||
    value.gitSha !== sourceSha ||
    value.desktopBuildProfile !== 'release' ||
    !Array.isArray(value.phases) ||
    value.phases.some(
      (phase) =>
        !phase ||
        typeof phase.phase !== 'string' ||
        !phase.phase ||
        phase.status !== 'success' ||
        !Number.isSafeInteger(phase.durationMs) ||
        phase.durationMs < 0,
    )
  )
    return false;
  const names = value.phases.map((phase) => phase.phase);
  return (
    new Set(names).size === names.length &&
    REQUIRED_BUILD_PHASES.every((name) => names.includes(name))
  );
}

export async function preserveBuildTiming(source, destination, sourceSha) {
  let evidence;
  try {
    const value = JSON.parse(await readFile(source, 'utf8'));
    if (!validBuildTiming(value, sourceSha)) throw new Error('Invalid build measurement');
    evidence = value;
  } catch {
    // Timing is optional; never substitute a successful measurement.
    evidence = { measurementUnavailable: true };
  }
  await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = await preserveBuildTiming(...process.argv.slice(2));
    if (evidence.measurementUnavailable)
      console.warn('Build timing unavailable; target remains unverified.');
  } catch {
    // Failure to record a metric is not a failure of already verified product bytes.
    console.warn('Build timing could not be recorded; target remains unverified.');
  }
}
