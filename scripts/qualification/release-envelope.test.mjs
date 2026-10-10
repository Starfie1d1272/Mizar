import { expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import {
  decodeEvidence,
  encodeEvidence,
  evidenceName,
  makeUpdateIndex,
  verifyPromotionEvidence,
} from './release-envelope.mjs';

const python = process.platform === 'win32' ? 'python' : 'python3';
it('preserves original evidence bytes in an independently readable deterministic ZIP', () => {
  const bytes = Buffer.from([0, 255, 13, 10, 123, 125]);
  const entries = new Map([
    ['product/release-manifest.json', bytes],
    ['evidence/qualification.txt', Buffer.from('original\r\n')],
  ]);
  const archive = encodeEvidence(entries);
  expect(encodeEvidence(new Map([...entries].reverse()))).toEqual(archive);
  const extracted = execFileSync(
    python,
    [
      '-c',
      "import sys,io,zipfile;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));sys.stdout.buffer.write(z.read('product/release-manifest.json'))",
    ],
    { input: archive },
  );
  expect(extracted).toEqual(bytes);
  expect(decodeEvidence(archive)).toEqual(entries);
  expect(evidenceName('2.3.0')).toBe('Mizar-v2.3.0-evidence.zip');
  expect(() => evidenceName('../2.3.0')).toThrow();
});

it('rejects unsafe, ambiguous, active, damaged or excessive evidence containers', () => {
  for (const name of [
    '../a.json',
    'product/../a.json',
    'product/a.exe',
    'product/a/b.json',
    '/product/a.json',
  ])
    expect(() => encodeEvidence(new Map([[name, Buffer.from('x')]]))).toThrow();
  expect(() =>
    encodeEvidence(
      new Map([
        ['product/A.json', Buffer.from('a')],
        ['product/a.json', Buffer.from('b')],
      ]),
    ),
  ).toThrow();
  expect(() => encodeEvidence(new Map([['product/a.json', Buffer.alloc(33554433)]]))).toThrow();
  for (const mode of ['traversal', 'duplicate', 'symlink', 'active', 'crc']) {
    const archive = execFileSync(python, [
      '-c',
      `import sys,io,zipfile
out=io.BytesIO()
with zipfile.ZipFile(out,'w') as z:
 mode=sys.argv[1]
 name={'traversal':'../a.json','active':'product/a.exe'}.get(mode,'product/a.json')
 info=zipfile.ZipInfo(name)
 if mode=='symlink': info.external_attr=0o120777<<16
 z.writestr(info,b'UNIQUE-CONTENT')
 if mode=='duplicate': z.writestr('product/A.json',b'other')
data=out.getvalue()
if mode=='crc': data=data.replace(b'UNIQUE-CONTENT',b'BROKEN-CONTENT')
sys.stdout.buffer.write(data)
`,
      mode,
    ]);
    expect(() => decodeEvidence(archive)).toThrow();
  }
  expect(() => decodeEvidence(Buffer.from('PK truncated'))).toThrow();
});

it('retains the original production v1.1 dual-signature payload bytes in the v2 carrier', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../../apps/companion/test/fixtures/updates/update-index-v2.json', import.meta.url),
    ),
  );
  const manifest = Buffer.from(fixture.manifestBase64, 'base64');
  const publication = Buffer.from(fixture.publicationBase64, 'base64');
  const index = JSON.parse(
    makeUpdateIndex(
      manifest,
      Buffer.from(JSON.stringify(fixture.provenance)),
      publication,
      Buffer.from(JSON.stringify(fixture.publicationProvenance)),
    ),
  );
  expect(Buffer.from(index.manifestBase64, 'base64')).toEqual(manifest);
  expect(Buffer.from(index.publicationBase64, 'base64')).toEqual(publication);
  expect(index.provenance).toEqual(fixture.provenance);
  expect(index.publicationProvenance).toEqual(fixture.publicationProvenance);
  const substituted = JSON.parse(publication);
  substituted.releaseId++;
  // Container conversion does not assert cryptographic validity; the real dual
  // signature verification is owned by updates-source.test.ts.
  expect(() =>
    makeUpdateIndex(Buffer.alloc(65537), Buffer.from('{}'), publication, Buffer.from('{}')),
  ).toThrow();
  expect(() =>
    makeUpdateIndex(
      manifest,
      Buffer.from('{}'),
      Buffer.from(JSON.stringify({ ...substituted, manifestSha256: '0'.repeat(64) })),
      Buffer.from('{}'),
    ),
  ).toThrow();
});

it('refuses an incomplete qualification bundle offered as complete promoter evidence', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../../apps/companion/test/fixtures/updates/update-index-v2.json', import.meta.url),
    ),
  );
  await expect(
    verifyPromotionEvidence(
      new Map([
        ['promotion-records-provenance.json', Buffer.from(JSON.stringify(fixture.provenance))],
      ]),
    ),
  ).rejects.toThrow();
});
