import { createHash } from 'node:crypto';
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';

export const PACK_LIMITS = {
  manifest: 256 * 1024,
  files: 4095,
  file: 128 * 1024 * 1024,
  total: 512 * 1024 * 1024,
} as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const resource = z
  .object({ id: z.string().min(1).max(256), version: z.string().min(1).max(128), digest: sha })
  .strict();
const file = z
  .object({
    id,
    path: z.string().min(1).max(240),
    mediaType: z.string().min(1).max(128),
    bytes: z.number().int().nonnegative().max(PACK_LIMITS.file),
    sha256: sha,
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal('mizar.pack'),
    formatVersion: z.literal(1),
    packageId: z.string().uuid(),
    version: z
      .string()
      .max(128)
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    name: z.string().min(1).max(256),
    author: z.string().max(256),
    description: z.string().max(4096).optional(),
    defaultPreset: id.optional(),
    modules: z
      .array(
        z
          .object({
            entryId: id,
            module: id,
            schemaVersion: z.number().int().positive().safe(),
            fileId: id,
            required: z.boolean(),
          })
          .strict(),
      )
      .max(PACK_LIMITS.files),
    presets: z
      .array(z.object({ entryId: id, schemaVersion: z.literal(1), fileId: id }).strict())
      .max(PACK_LIMITS.files),
    dependencies: z
      .array(
        z
          .object({
            alias: id,
            resource,
            delivery: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('external') }).strict(),
              z
                .object({
                  kind: z.literal('embedded'),
                  archiveFileId: id,
                  format: z.enum(['mizar.pack.v1', 'lhm-cs2-zip']),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(PACK_LIMITS.files),
    requirements: z
      .array(
        z
          .object({
            capability: id,
            major: z.number().int().positive().safe(),
            required: z.boolean(),
            usedBy: z.array(id).max(PACK_LIMITS.files),
          })
          .strict(),
      )
      .max(PACK_LIMITS.files),
    files: z.array(file).max(PACK_LIMITS.files),
  })
  .strict();
export type PackManifestV1 = z.infer<typeof manifestSchema>;
export type ResourceRef = z.infer<typeof resource>;
export interface TemplateAssetRef {
  package: string; // "$self" or a dependency alias
  fileId: string;
}

function validString(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function uniqueKeys(node: JsonNode): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string;
      if (!validString(key) || keys.has(key)) throw new Error('package_invalid');
      keys.add(key);
    }
  }
  if (node.type === 'string' && !validString(node.value as string))
    throw new Error('package_invalid');
  for (const child of node.children ?? []) uniqueKeys(child);
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new Error('package_invalid');
}
function safePath(path: string): boolean {
  return (
    !/[\\:<>"|?*]/.test(path) &&
    [...path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
    path
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
  );
}
function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

/** Parse strict JSON before hashing; the digest is independent of ZIP encoding. */
export function parseManifest(bytes: Uint8Array): { manifest: PackManifestV1; digest: string } {
  if (bytes.length > PACK_LIMITS.manifest) throw new Error('package_budget_exceeded');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) throw new Error('package_invalid');
  uniqueKeys(tree);
  const raw: unknown = JSON.parse(text);
  const manifest = manifestSchema.parse(raw);
  const paths = manifest.files.map((f) => f.path.toLowerCase());
  const ids = new Set(manifest.files.map((f) => f.id));
  const entries = [...manifest.modules, ...manifest.presets];
  const entryIds = new Set(entries.map((e) => e.entryId));
  if (
    !unique(manifest.files.map((f) => f.id)) ||
    !unique(paths) ||
    !unique(entries.map((e) => e.entryId)) ||
    !unique(manifest.dependencies.map((d) => d.alias)) ||
    manifest.dependencies.some((d) => d.alias === '$self') ||
    manifest.files.some(
      (f) =>
        !safePath(f.path) ||
        f.path.toLowerCase() === 'manifest.json' ||
        f.path.toLowerCase().startsWith('manifest.json/'),
    ) ||
    paths.some((p) => paths.some((other) => other.startsWith(`${p}/`))) ||
    manifest.files.reduce((n, f) => n + f.bytes, bytes.length) > PACK_LIMITS.total ||
    entries.some((e) => !ids.has(e.fileId)) ||
    manifest.dependencies.some(
      (d) => d.delivery.kind === 'embedded' && !ids.has(d.delivery.archiveFileId),
    ) ||
    manifest.requirements.some((r) => r.usedBy.some((entry) => !entryIds.has(entry))) ||
    (manifest.defaultPreset !== undefined &&
      !manifest.presets.some((p) => p.entryId === manifest.defaultPreset))
  )
    throw new Error('package_invalid');
  return { manifest, digest: createHash('sha256').update(canonical(raw)).digest('hex') };
}

/** Verify already bounded archive members. This does not authorize or install a package. */
export function verifyFiles(
  manifest: PackManifestV1,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  if (files.size !== manifest.files.length) throw new Error('package_invalid');
  for (const file of manifest.files) {
    const bytes = files.get(file.path);
    if (
      !bytes ||
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('package_invalid');
  }
}

export { readPackArchive, writePackArchive } from './archive.js';
