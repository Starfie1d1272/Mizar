import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function preserveBuildTiming(source, destination, sourceSha) {
  let evidence;
  try {
    const value = JSON.parse(await readFile(source, 'utf8'));
    if (
      value.gitSha !== sourceSha ||
      value.desktopBuildProfile !== 'release' ||
      !Array.isArray(value.phases) ||
      !['desktop-cargo-build', 'zip-archive'].every((name) =>
        value.phases.some(
          (phase) =>
            phase.phase === name &&
            phase.status === 'success' &&
            Number.isFinite(phase.durationMs) &&
            phase.durationMs >= 0,
        ),
      )
    )
      throw new Error('Invalid build measurement');
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
