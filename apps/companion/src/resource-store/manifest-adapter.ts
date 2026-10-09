import type { StoreOptions, TrustedPack } from './contract.js';

/** Structural boundary for the exports owned by resource-pack-contract and resource-provenance. */
export interface ResourcePackConsumer {
  parsePackManifest: (value: unknown) => {
    packId: string;
    packVersion: string;
    compatibility: unknown;
    files: TrustedPack['files'];
  };
  assertResourcePath: (path: unknown) => string;
  assertCompatibility: (compatibility: unknown, coreVersion?: string) => void;
  /** Return the manifest only after real signature/identity authorization; cache calls are offline. */
  verifyReceipt: (input: {
    packId: string;
    receipt: unknown;
    signal: AbortSignal;
    purpose: 'install' | 'cache' | 'legacy' | 'rollback';
  }) => Promise<unknown>;
}

/** Consume the shared parser and path checks without importing an unmerged branch or duplicating them. */
export function createManifestVerifier(
  consumer: ResourcePackConsumer,
  coreVersion: string,
): StoreOptions['verifyTrustedPack'] {
  return async ({ packId, receipt, signal, purpose }) => {
    signal.throwIfAborted();
    const manifest = consumer.parsePackManifest(
      await consumer.verifyReceipt({ packId, receipt, signal, purpose }),
    );
    signal.throwIfAborted();
    for (const file of manifest.files) consumer.assertResourcePath(file.path);
    let compatible = true;
    try {
      consumer.assertCompatibility(manifest.compatibility, coreVersion);
    } catch {
      compatible = false;
    }
    return {
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      compatible,
      files: manifest.files,
    };
  };
}
