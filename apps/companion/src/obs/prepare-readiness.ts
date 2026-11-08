import type { ObsFinding } from './reconcile.js';

/** Keep explicit operator audio choices visible without treating them as configuration failures. */
export function obsFindingReadiness(findings: readonly ObsFinding[]) {
  const warnings: ObsFinding[] = [];
  const blockingFindings: ObsFinding[] = [];
  for (const finding of findings) {
    const code = finding.code.split(':', 1)[0] ?? '';
    const audioWarning =
      code.startsWith('audio_') || code === 'game_audio_missing' || code === 'commentary_pending';
    (audioWarning ? warnings : blockingFindings).push(finding);
  }
  return { blockingFindings, warnings };
}
