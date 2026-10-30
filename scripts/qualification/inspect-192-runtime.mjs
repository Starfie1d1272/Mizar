import { BoxClient } from './box-sync.mjs';

const box = new BoxClient(process.env.MIZAR_BOX_REPO_TOKEN);
const name = 'Mizar-v1.9.2-Windows-x64-Core-Setup.exe';
const expected = { size: 118361183, sha256: '5b0024d2bb996b1fc5e136c7ebad628c60c636bb980ddb4702dd280e5c95d914' };
await box.initialize();
const archive = await box.list('/Archive');
const stages = archive.filter((entry) => entry.type === 'dir' && /^mizar-runtime-[a-f0-9-]{36}$/.test(entry.name));
if (stages.length > 100) throw new Error('Too many staging directories to inspect safely');
console.log(`Staging directory count: ${stages.length}`);
for (const stage of stages) {
  const folder = `/Archive/${stage.name}`;
  const entries = await box.list(folder);
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length > 1 || matches.some((entry) => entry.type !== 'file')) throw new Error('Ambiguous staging file');
  if (!matches.length) {
    console.log(JSON.stringify({ stage: stage.name, visibleTarget: false }));
    continue;
  }
  const actual = await box.hash(`${folder}/${name}`);
  console.log(JSON.stringify({ stage: stage.name, visibleTarget: true, ...actual, completeMatch: actual.size === expected.size && actual.sha256 === expected.sha256 }));
}
const runtime = await box.list('/Runtime/v1.9.2');
const target = runtime.filter((entry) => entry.name === name);
if (target.length > 1 || target.some((entry) => entry.type !== 'file')) throw new Error('Ambiguous Runtime file');
console.log(JSON.stringify({ runtimeTarget: target.length ? await box.hash(`/Runtime/v1.9.2/${name}`) : null }));
console.log('Read-only inspection; invisible temporary upload sessions remain unknown.');
