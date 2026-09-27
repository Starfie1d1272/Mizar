import { inspectBp } from '@mizar/core/projection';
import {
  getBpDemoManifest,
  validateBroadcastManifest,
  toMatchContext,
  type BpDemoFormat,
} from '@mizar/rivalhub';
import type { BpProjection } from '@mizar/core/projection';

const projections = new Map<BpDemoFormat, BpProjection>();

export function getBpDemoProjection(format: BpDemoFormat): BpProjection {
  const cached = projections.get(format);
  if (cached !== undefined) return cached;

  const validated = validateBroadcastManifest(getBpDemoManifest(format));
  if (!validated.ok) {
    throw new Error(
      `BP Demo Manifest ${format} 无效：${validated.diagnostics.map((item) => item.code).join(', ')}`,
    );
  }
  const context = toMatchContext(validated.value);
  const inspected = inspectBp(context);
  if (inspected.readiness !== 'ready' || inspected.projection === null) {
    throw new Error(`BP Demo Manifest ${format} 无法生成就绪投影。`);
  }
  projections.set(format, inspected.projection);
  return inspected.projection;
}
