import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { URL } from 'node:url';
import console from 'node:console';

const root = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
for (const entry of manifest.files) {
  const bytes = await readFile(new URL(entry.file, root));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error(`Hash mismatch: ${entry.file}`);
  const text = gunzipSync(bytes).toString('utf8');
  const frames = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (frames.length !== entry.frameCount) throw new Error(`Frame count: ${entry.file}`);
  if (entry.firstSequence !== undefined && frames[0].sequence !== entry.firstSequence)
    throw new Error(`First sequence: ${entry.file}`);
  if (entry.lastSequence !== undefined && frames.at(-1).sequence !== entry.lastSequence)
    throw new Error(`Last sequence: ${entry.file}`);
  for (let index = 1; index < frames.length; index++)
    if (frames[index].sequence !== frames[index - 1].sequence + 1)
      throw new Error(`Sequence gap: ${entry.file}`);
  if (/[A-Za-z]:\\|Bearer |"(?:auth|token|password|cookie)"\s*:/i.test(text))
    throw new Error(`Sensitive field: ${entry.file}`);
  console.log(`${entry.file}: ${frames.length} consecutive frames verified`);
}
const files = await readdir(root);
for (const entry of manifest.supplementalCollection?.files ?? []) {
  const bytes = await readFile(new URL(entry.file, root));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error(`Supplemental hash mismatch: ${entry.file}`);
  if (entry.file.endsWith('.gz')) {
    const text = gunzipSync(bytes).toString('utf8');
    if (/[A-Za-z]:\\|Bearer |"(?:auth|token|password|cookie)"\s*:/i.test(text))
      throw new Error(`Sensitive supplemental field: ${entry.file}`);
  }
  console.log(`${entry.file}: supplemental hash verified`);
}
console.log(`${files.length} files; identity-redacted reference evidence, not a gold fixture`);
