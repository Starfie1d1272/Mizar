export type ResourcePhase =
  'missing' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'incompatible';

/** Produced by the external manifest/provenance adapter, never by a mirror alone. */
export interface TrustedPack {
  packId: string;
  packVersion: string;
  compatible: boolean;
  files: readonly { path: string; bytes: number; sha256: string }[];
}

export interface ResourceStatus {
  packId: string;
  phase: ResourcePhase;
  downloadedBytes: number;
  activeVersion: string | null;
  preparedVersion: string | null;
  rollbackVersion: string | null;
  failure: string | null;
}

export interface PreparePack {
  /** Only writes into this empty staging directory; extraction limits belong to the producer. */
  (input: {
    directory: string;
    signal: AbortSignal;
    onProgress: (bytes: number) => void;
  }): Promise<unknown>;
}

export interface ResourceInstallOptions {
  signal?: AbortSignal;
  packVersion?: string;
  force?: boolean;
}

export interface StoreOptions {
  root: string;
  packs?: readonly { packId: string; optional?: boolean }[];
  /** Must verify authorization and compatibility offline from the persisted receipt on cache hits. */
  verifyTrustedPack: (input: {
    directory: string;
    packId: string;
    receipt: unknown;
    signal: AbortSignal;
    purpose: 'install' | 'cache' | 'legacy' | 'rollback';
  }) => Promise<TrustedPack>;
  /** Integration holds its production/preparation lease throughout commit. Without it, prepare only. */
  activateWhenSafe?: (commit: () => Promise<void>) => Promise<boolean>;
}

export class ResourceStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly totalBytes?: number,
  ) {
    super(code);
  }
}
