import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Resolve only image fields declared by the HUD and present in its instance config. */
export async function panelImageRefs(
  root: string,
  config: Record<string, unknown>,
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  try {
    const file = await readFile(join(root, 'panel.json'), 'utf8');
    if (Buffer.byteLength(file) > 256_000) return refs;
    const sections: unknown = JSON.parse(file);
    if (!Array.isArray(sections)) return refs;
    for (const value of sections) {
      const section = record(value);
      if (
        !section ||
        typeof section.name !== 'string' ||
        !/^[\w-]+$/.test(section.name) ||
        !Array.isArray(section.inputs)
      )
        continue;
      const values = record(config[section.name]);
      if (!values) continue;
      for (const inputValue of section.inputs as unknown[]) {
        const input = record(inputValue);
        if (
          !input ||
          input.type !== 'image' ||
          typeof input.name !== 'string' ||
          !/^[\w-]+$/.test(input.name)
        )
          continue;
        const ref = values[input.name];
        if (
          typeof ref === 'string' &&
          /^\/local\/v1\/local-assets\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(ref)
        )
          refs.set(`${section.name}/${input.name}`, ref);
      }
    }
  } catch {
    /* An absent or malformed panel exposes no images. */
  }
  return refs;
}
