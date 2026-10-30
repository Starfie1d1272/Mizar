import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BoxClient } from './box-sync.mjs';

const name = 'Mizar-v1.9.2-Windows-x64-WebInstaller.exe';
const bytes = await readFile(process.argv[2]);
const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
if (expected.size !== 249856) throw new Error('Original qualified installer size differs');
const box = new BoxClient(process.env.MIZAR_BOX_REPO_TOKEN);
await box.initialize();
const source = (await box.list('/Stable/Downloads')).filter((entry) => entry.name === name);
if (source.length !== 1 || source[0].type !== 'file' || source[0].size !== expected.size)
  throw new Error('Public installer absent or ambiguous; no write performed');
const archive = (await box.list('/Archive')).filter((entry) => entry.name === name);
if (archive.length) throw new Error('Archive destination already exists; no write performed');
const actual = await box.hash(`/Stable/Downloads/${name}`);
if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
  throw new Error('Public bytes do not match the qualified original; no write performed');
console.log(`Verified original 1.9.2 installer: ${expected.size} bytes, SHA-256 ${expected.sha256}`);
await box.move('/Stable/Downloads', '/Archive', name);
const remaining = (await box.list('/Stable/Downloads')).filter((entry) => entry.name === name);
const moved = (await box.list('/Archive')).filter((entry) => entry.name === name);
if (remaining.length || moved.length !== 1 || moved[0].type !== 'file')
  throw new Error('Move outcome is uncertain; do not replay');
const archived = await box.hash(`/Archive/${name}`);
if (archived.size !== expected.size || archived.sha256 !== expected.sha256)
  throw new Error('Archived bytes differ; preserve state');
console.log('Withdrawn installer isolated in Archive; public Downloads no longer lists it.');
