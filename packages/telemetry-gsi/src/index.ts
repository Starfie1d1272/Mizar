import productionGsiConfig from './production-config.json' with { type: 'json' };

export { adaptGsiPayload } from './adapter.js';
export type { GsiAdaptResult } from './adapter.js';
export const PRODUCTION_GSI_CONFIG = productionGsiConfig;
export {
  MAX_DIAGNOSTICS_PER_FRAME,
  type GsiDiagnostic,
  type GsiDiagnosticBatch,
  type GsiDiagnosticCode,
  type GsiDiagnosticSeverity,
} from './diagnostics/types.js';
export type { TelemetryReceiveContext } from '@mizar/core/telemetry';
