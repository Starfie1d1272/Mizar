import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export class QualificationEvidenceError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'QualificationEvidenceError';
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadQualificationContract() {
  const candidates = [
    join(MODULE_DIR, '..', 'qualification-contract.json'),
    resolve(MODULE_DIR, '../../../apps/companion/src/qualification/contract.json'),
  ];
  let lastError;
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`缺少现场验收契约：${String(lastError)}`);
}

function validateQualificationContract(contract) {
  if (!isRecord(contract) || !Number.isSafeInteger(contract.schemaVersion)) {
    throw new Error('现场验收契约的版本号无效');
  }
  for (const key of [
    'markerKinds',
    'objectiveScenarioMarkerKinds',
    'liveMarkerKinds',
    'markerPhases',
    'freshnessValues',
    'resultValues',
    'checkKeys',
    'resetDispositionValues',
    'resetEvidenceFields',
    'qualificationProfiles',
    'hostScenarios',
    'releaseCheckKeys',
  ]) {
    if (
      !Array.isArray(contract[key]) ||
      contract[key].length === 0 ||
      contract[key].some((value) => typeof value !== 'string' || value.length === 0)
    ) {
      throw new Error(`现场验收契约的 ${key} 无效`);
    }
  }
  if (
    !Number.isSafeInteger(contract.maxMarkers) ||
    contract.maxMarkers <= 0 ||
    typeof contract.nodeRuntimeVersion !== 'string' ||
    typeof contract.resetKind !== 'string' ||
    typeof contract.resetReason !== 'string'
  ) {
    throw new Error('现场验收契约的标量值无效');
  }
  return contract;
}

export const QUALIFICATION_CONTRACT = validateQualificationContract(loadQualificationContract());
export const QUALIFICATION_SCHEMA_VERSION = QUALIFICATION_CONTRACT.schemaVersion;
export const QUALIFICATION_REPOSITORY = 'Starfie1d1272/Mizar';
export const QUALIFICATION_MARKER_KINDS = new Set(QUALIFICATION_CONTRACT.markerKinds);
export const QUALIFICATION_OBJECTIVE_SCENARIO_MARKER_KINDS = new Set(
  QUALIFICATION_CONTRACT.objectiveScenarioMarkerKinds,
);
export const QUALIFICATION_LIVE_MARKER_KINDS = new Set(QUALIFICATION_CONTRACT.liveMarkerKinds);
export const QUALIFICATION_FRESHNESS_VALUES = new Set(QUALIFICATION_CONTRACT.freshnessValues);
export const QUALIFICATION_RESULT_VALUES = new Set(QUALIFICATION_CONTRACT.resultValues);
export const QUALIFICATION_MARKER_PHASES = new Set(QUALIFICATION_CONTRACT.markerPhases);
export const QUALIFICATION_RESET_DISPOSITIONS = new Set(
  QUALIFICATION_CONTRACT.resetDispositionValues,
);
export const QUALIFICATION_RESET_EVIDENCE_FIELDS = QUALIFICATION_CONTRACT.resetEvidenceFields;
export const QUALIFICATION_CHECK_KEYS = QUALIFICATION_CONTRACT.checkKeys;
export const QUALIFICATION_PROFILES = new Set(QUALIFICATION_CONTRACT.qualificationProfiles);
export const HOST_CHECKPOINT_SCHEMA_VERSION = QUALIFICATION_CONTRACT.hostCheckpointSchemaVersion;
export const HOST_SCENARIOS = new Set(QUALIFICATION_CONTRACT.hostScenarios);
export const RESTART_REQUEST_EXIT_CODE = QUALIFICATION_CONTRACT.restartRequestExitCode;
export const RELEASE_CHECK_KEYS = QUALIFICATION_CONTRACT.releaseCheckKeys;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const STEAM_LIKE_ID_PATTERN = /\b\d{17}\b/;
export const SECRET_PATTERN = /(?:token|password|secret|authorization|bearer)/i;
