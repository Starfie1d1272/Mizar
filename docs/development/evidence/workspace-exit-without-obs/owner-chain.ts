// The archived Rust entrypoint uses this same documented, fixed source checkout.
import {buildApp} from '/workspace/Mizar/apps/companion/src/app.js';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'linux', 'This archived harness is Linux-only boundary emulation.');
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'mizar-real-owner-exit-'));
const bin = fileURLToPath(new URL('./native/target/debug/owner_exit', import.meta.url));
const shim = join(root, 'probe-shim');
const count = join(root, 'process-count');
const {mkdir} = await import('node:fs/promises');
await mkdir(shim);
await writeFile(join(shim, 'powershell.exe'), '#!/bin/sh\ncat "$MIZAR_EXIT_COUNT_FIXTURE"\n', {mode: 0o700});
await run(bin, [root, 'prepare']);
const video = join(root, 'steam/userdata/1/730/local/cfg/cs2_video.txt');
const applied = await readFile(video);
const original = await readFile(join(root, 'expected-original.txt'));
assert.notDeepEqual(applied, original);
const app = buildApp({obsConfigPath:join(root,'obs.json'),matchManifestPath:join(root,'match.json'),localTournamentPath:join(root,'local.json')});
const platform = process.platform;
// Linux boundary emulation: run the actual Windows probe command against a fixed count fixture.
Object.defineProperty(process, 'platform', {value: 'win32'});
const previousPath = process.env.PATH;
const previousCountFixture = process.env.MIZAR_EXIT_COUNT_FIXTURE;
process.env.PATH = shim + ':' + previousPath;
process.env.MIZAR_EXIT_COUNT_FIXTURE = count;
const headers = {origin: 'http://127.0.0.1:3000'};
try {
 await app.listen({host:'127.0.0.1', port:3000});
 assert.equal((await app.inject({method:'POST',url:'/operator/local-match/create',headers,payload:{teamA:'A',teamB:'B',format:'bo3'}})).statusCode,200);
 const initial=(await app.inject('/local/v1/production')).json<{revision:string}>();
 assert.equal((await app.inject({method:'POST',url:'/operator/production',headers,payload:{action:'enter',expectedRevision:initial.revision}})).statusCode,200);
 await writeFile(count,'1\n');
 await assert.rejects(run(bin,[root]), /OBS 等待画面未确认/);
 assert.deepEqual(await readFile(video), applied);
 assert.equal((await app.inject('/local/v1/production')).json<{mode:string}>().mode,'live');
 console.log('actual Rust HTTP finish -> real Companion adapter -> running OBS proof blocks CS2 restore: PASS');
 await writeFile(count,'0\n');
 console.log((await run(bin,[root])).stdout.trim());
 assert.deepEqual(await readFile(video), original);
 assert.equal((await app.inject('/local/v1/production')).json<{mode:string}>().mode,'preparation');
 console.log('fresh absence retry -> actual Rust safety boundary -> real CS2 bytes restored: PASS');
 console.log('fixture root:',root);
} finally {
 await app.close();
 Object.defineProperty(process,'platform',{value:platform});
 process.env.PATH = previousPath;
 if (previousCountFixture === undefined) delete process.env.MIZAR_EXIT_COUNT_FIXTURE;
 else process.env.MIZAR_EXIT_COUNT_FIXTURE = previousCountFixture;
}
