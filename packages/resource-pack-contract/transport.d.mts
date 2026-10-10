import type { Buffer } from 'node:buffer';
export const MACHINE_METADATA_NAME: 'machine-metadata.json';
export const MACHINE_METADATA_MAX_BYTES: number;
export function makeMachineMetadata(files: Iterable<[string, Buffer]>): Buffer;
export function readMachineMetadata(bytes: Buffer): Map<string, Buffer>;
export function readMachineFile(bytes: Buffer, name: string): Buffer;
