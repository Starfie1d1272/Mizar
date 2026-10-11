import {buildApp} from '../../apps/companion/src/app.js';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
process.chdir('/workspace/Mizar');
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'mizar-real-owner-exit-'));
const bin = '/tmp/mizar-exit-native/target/debug/owner_exit';
await run(bin, [root, 'prepare']);
const video = join(root, 'steam/userdata/1/730/local/cfg/cs2_video.txt');
const applied = await readFile(video);
const original = await readFile(join(root, 'expected-original.txt'));
assert.notDeepEqual(applied, original);
const app = buildApp({obsConfigPath:join(root,'obs.json'),matchManifestPath:join(root,'match.json'),localTournamentPath:join(root,'local.json')});
const platform = process.platform;
// Linux boundary emulation: run the actual Windows probe command against a fixed count fixture.
Object.defineProperty(process, 'platform', {value: 'win32'});
process.env.PATH = '/workspace/Mizar/.agent-tmp/exit-owner/shim:' + process.env.PATH;
const headers = {origin: 'http://127.0.0.1:3000'};
try {
 await app.listen({host:'127.0.0.1', port:3000});
 assert.equal((await app.inject({method:'POST',url:'/operator/local-match/create',headers,payload:{teamA:'A',teamB:'B',format:'bo3'}})).statusCode,200);
 const initial=(await app.inject('/local/v1/production')).json<{revision:string}>();
 assert.equal((await app.inject({method:'POST',url:'/operator/production',headers,payload:{action:'enter',expectedRevision:initial.revision}})).statusCode,200);
 await writeFile('.agent-tmp/exit-owner/process-count','1\n');
 await assert.rejects(run(bin,[root]), /OBS 等待画面未确认/);
 assert.deepEqual(await readFile(video), applied);
 assert.equal((await app.inject('/local/v1/production')).json<{mode:string}>().mode,'live');
 console.log('actual Rust HTTP finish -> real Companion adapter -> running OBS proof blocks CS2 restore: PASS');
 await writeFile('.agent-tmp/exit-owner/process-count','0\n');
 console.log((await run(bin,[root])).stdout.trim());
 assert.deepEqual(await readFile(video), original);
 assert.equal((await app.inject('/local/v1/production')).json<{mode:string}>().mode,'preparation');
 console.log('fresh absence retry -> actual Rust safety boundary -> real CS2 bytes restored: PASS');
 console.log('fixture root:',root);
} finally {
 await app.close();
 Object.defineProperty(process,'platform',{value:platform});
}
