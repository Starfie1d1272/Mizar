export const LOCAL_PROTOCOL_VERSION = 1 as const;
export const PROGRAM_SCHEMA_VERSION = 9 as const;
export const PROGRAM_CUE_SCHEMA_VERSION = 1 as const;
export const RADAR_SCHEMA_VERSION = 2 as const;
export const OPERATOR_SCHEMA_VERSION = 4 as const;
export const ASSIST_SCHEMA_VERSION = 4 as const;

export const LOCAL_PROTOCOL_SUBPROTOCOL = 'mizar.local.v1' as const;

export const LOCAL_SNAPSHOT_VERSIONS = {
  program: PROGRAM_SCHEMA_VERSION,
  radar: RADAR_SCHEMA_VERSION,
  operator: OPERATOR_SCHEMA_VERSION,
  assist: ASSIST_SCHEMA_VERSION,
} as const;

export const LOCAL_SNAPSHOT_CHANNELS = ['program', 'radar', 'operator', 'assist'] as const;
export const LOCAL_TRANSIENT_CHANNELS = ['program-cue'] as const;
export const LOCAL_CHANNELS = [...LOCAL_SNAPSHOT_CHANNELS, ...LOCAL_TRANSIENT_CHANNELS] as const;
export type LocalSnapshotChannel = (typeof LOCAL_SNAPSHOT_CHANNELS)[number];
export type LocalTransientChannel = (typeof LOCAL_TRANSIENT_CHANNELS)[number];
export type LocalChannel = LocalSnapshotChannel | LocalTransientChannel;

/** Explicit consent for seven-day bodies and a ninety-day identifiable session index. */
export const DIAGNOSTIC_CONSENT_REVISION = 'technical-diagnostics-v3' as const;
