// Compact references from docs/screenshots/hud-*.png; never represent the selected live match.
import pulseReference from './hud-reference/pulse.webp';
import eslReference from './hud-reference/esl.webp';
import iemReference from './hud-reference/iem.webp';
import ewcReference from './hud-reference/ewc.webp';
import pwReference from './hud-reference/pw.webp';

const styleReferences: Record<string, string> = {
  default: pulseReference,
  esl: eslReference,
  iem: iemReference,
  ewc: ewcReference,
  perfectworld: pwReference,
};

export function hudStyleReference(variant: string): string {
  return styleReferences[variant] ?? pulseReference;
}
