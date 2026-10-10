import { Buffer } from 'node:buffer';
import { assertPublication } from './update-publication.mjs';
export function makeUpdateIndex(
  manifestBytes,
  provenanceBytes,
  publicationBytes,
  publicationProvenanceBytes,
) {
  for (const bytes of [manifestBytes, publicationBytes])
    if (bytes.length > 65536) throw new Error('更新元数据超限');
  for (const bytes of [provenanceBytes, publicationProvenanceBytes])
    if (bytes.length > 2097152) throw new Error('更新证明超限');
  assertPublication(JSON.parse(publicationBytes), manifestBytes, JSON.parse(manifestBytes));
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 'mizar.update-index.v2',
      manifestBase64: manifestBytes.toString('base64'),
      provenance: JSON.parse(provenanceBytes),
      publicationBase64: publicationBytes.toString('base64'),
      publicationProvenance: JSON.parse(publicationProvenanceBytes),
    }) + '\n',
  );
  if (bytes.length > 2097152) throw new Error('更新信封超限');
  return bytes;
}

if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('/update-index.mjs')) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const [manifest, proof, publication, publicationProof, output] = process.argv.slice(2);
  await writeFile(
    output,
    makeUpdateIndex(
      await readFile(manifest),
      await readFile(proof),
      await readFile(publication),
      await readFile(publicationProof),
    ),
    { flag: 'wx' },
  );
}
