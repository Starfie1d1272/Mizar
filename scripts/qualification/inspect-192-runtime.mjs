import { BoxClient } from './box-sync.mjs';

const box = new BoxClient(process.env.MIZAR_BOX_REPO_TOKEN);
await box.initialize();
const entries = await box.list('/Updates');
const latest = entries.filter((entry) => entry.name === 'latest.json');
if (latest.length !== 1 || latest[0].type !== 'file') throw new Error('Box latest is absent or ambiguous');
const actual = await box.hash('/Updates/latest.json');
const expected191 = { size: 26334, sha256: '1a620f73fff489de6f5db08438c53ba6f6dddf4415cd52ce5151494cf4663f5f' };
const expected192 = { size: 27266, sha256: '1576bd4848d4a44c4405a4435688aacf97f1bea931eda98ac99c7d6ba22e53a5' };
const matches = (expected) => actual.size === expected.size && actual.sha256 === expected.sha256;
console.log(JSON.stringify({ latest: actual, matches191: matches(expected191), matches192: matches(expected192) }));
