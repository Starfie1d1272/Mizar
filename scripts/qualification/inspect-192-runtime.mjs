import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BoxClient, verifyPublicDownloads } from './box-sync.mjs';

const name = 'Mizar-v1.9.1-Windows-x64-WebInstaller.exe';
const bytes = await readFile(process.argv[2]);
const identity = { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
if (identity.size !== 249856) throw new Error('Original 1.9.1 installer size differs');
const box = new BoxClient(process.env.MIZAR_BOX_REPO_TOKEN);
await box.initialize();
const source = (await box.list('/Archive')).filter((entry) => entry.name === name);
if (source.length !== 1 || source[0].type !== 'file')
  throw new Error('Original installer not uniquely present in Archive; no write performed');
const current = await box.list('/Stable/Downloads');
if (current.length) throw new Error('Public Downloads not empty; no write performed');
const actual = await box.hash(`/Archive/${name}`);
if (actual.size !== identity.size || actual.sha256 !== identity.sha256)
  throw new Error('Archived bytes do not match the signed original; no write performed');
console.log(`Verified original 1.9.1 installer: ${identity.size} bytes, SHA-256 ${identity.sha256}`);
await box.move('/Archive', '/Stable/Downloads', name);
const archived = (await box.list('/Archive')).filter((entry) => entry.name === name);
if (archived.length) throw new Error('Move outcome uncertain; do not replay');
const result = await verifyPublicDownloads({ bootstrap: { identity } });
console.log(result);
