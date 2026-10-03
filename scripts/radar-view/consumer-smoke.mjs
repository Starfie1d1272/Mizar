import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = await mkdtemp(join(tmpdir(), 'mizar-radar-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });
// The repository build must precede this check. Pack exactly the built artifacts.
run(
  npm,
  ['pack', '--silent', '--ignore-scripts', '--pack-destination', work],
  join(root, 'packages/radar-view'),
);
const tarball = (await readdir(work)).find((name) => name.endsWith('.tgz'));
assert(tarball);
await writeFile(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run(
  npm,
  [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(work, tarball),
    'react@19.3.0',
    'react-dom@19.3.0',
    '@types/react@19.3.0',
    '@types/react-dom@19.3.0',
  ],
  work,
);
const installed = join(work, 'node_modules/@mizar/radar-view');
const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
assert(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0);
assert.equal(manifest.peerDependencies.react, '^19.0.0');
const fixture = JSON.parse(
  await readFile(join(root, 'packages/protocol/test/fixtures/live-snapshot-v1.radar.json'), 'utf8'),
);
const rivalhub = process.argv[2] && resolve(process.argv[2]);
let projection;
if (rivalhub) {
  // Exercise the actual receiving repository's public projector, not a copied implementation.
  const sourcePath = join(rivalhub, 'src/lib/mizar/live-projection.ts');
  const source = await readFile(sourcePath, 'utf8');
  await writeFile(
    join(work, 'projector.mjs'),
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  projection = (await import(pathToFileURL(join(work, 'projector.mjs')).href)).projectPublicLive(
    fixture,
    7,
    fixture.producedAt,
  );
  await writeFile(
    join(work, 'public-live-projection.ts'),
    `export type { PublicLiveMatchProjection } from ${JSON.stringify(sourcePath)};\n`,
  );
  console.log(
    `RivalHub projection revision: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rivalhub, encoding: 'utf8' }).trim()}`,
  );
} else {
  // CI uses the producer's checked-in cross-repository contract fixture.
  projection = {
    ...fixture,
    delivery: {
      authorityRevision: 7,
      generation: fixture.cursor.programSourceGeneration,
      epoch: fixture.cursor.mapEpoch,
      sequence: fixture.cursor.runtimeSeq,
    },
  };
  await writeFile(
    join(work, 'public-live-projection.ts'),
    `import type { PublicRadarInput, RadarBomb } from '@mizar/radar-view';\nexport interface PublicLiveMatchProjection { matchId: string; delivery: {authorityRevision:number;generation:number;epoch:number;sequence:number}; radar:PublicRadarInput|null; bomb:RadarBomb|null; capability:{radarCurrent:boolean;identity:string} }\n`,
  );
}
await cp(
  join(root, 'packages/radar-view/examples/RivalHubRadar.tsx'),
  join(work, 'RivalHubRadar.tsx'),
);
await writeFile(join(work, 'styles.d.ts'), "declare module '*.css';\n");
await writeFile(
  join(work, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      noEmit: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      jsx: 'react-jsx',
      allowImportingTsExtensions: true,
    },
    include: ['*.tsx', '*.ts'],
  }),
);
// NodeNext consumer also checks declaration imports rather than relying on a bundler alias.
let example = await readFile(join(work, 'RivalHubRadar.tsx'), 'utf8');
example = example.replace("'./public-live-projection'", "'./public-live-projection.js'");
await writeFile(join(work, 'RivalHubRadar.tsx'), example);
run(
  join(root, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
  ['-p', join(work, 'tsconfig.json')],
  work,
);
await writeFile(join(work, 'fixture.json'), JSON.stringify(projection));
await writeFile(
  join(work, 'smoke.mjs'),
  `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { RadarView, fromPublicRadar, getRadarArtwork } from '@mizar/radar-view';
import { RadarPresentation } from '@mizar/radar-view/presentation';
const live = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
const frame = fromPublicRadar(live.radar, { boundary: JSON.stringify([live.matchId, live.delivery]), sequence: live.delivery.sequence, current: true, bomb: live.bomb });
const model = new RadarPresentation(); model.accept(frame, 0);
assert(model.players.size > 0); assert(model.grenades.size > 0);
assert(renderToString(createElement(RadarView, {snapshot: frame, assetBaseUrl:'/vendor/radar/0.1.0'})).includes('canvas'));
for (const path of Object.values(getRadarArtwork(frame.mapName).artwork)) {
  const file = import.meta.resolve('@mizar/radar-view/assets/' + path.replace(/^\\//, ''));
  assert((await readFile(new URL(file))).length > 0);
}
console.log('Standalone installed ESM, declarations, SSR, players/utility/flames and packaged map assets: passed');
`,
);
run(process.execPath, ['smoke.mjs'], work);
await cp(join(installed, 'dist/assets'), join(work, 'public/vendor/radar/0.1.0'), {
  recursive: true,
});
await writeFile(
  join(work, 'index.html'),
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>共享雷达外部消费验证</title><div id="root"></div><script type="module" src="/main.jsx"></script></html>',
);
await writeFile(
  join(work, 'main.jsx'),
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RivalHubRadar } from './RivalHubRadar';
import live from './fixture.json';
const root = createRoot(document.getElementById('root'));
let revision = 0;
function render(status) {
  root.render(React.createElement('main', {style:{fontFamily:'sans-serif',background:'#111827',color:'white',padding:20}},
    React.createElement('h1',null,'共享雷达外部消费验证'),
    ...['fresh','stale','unavailable'].map(value => React.createElement('button',{key:value,onClick:()=>{if(value==='fresh')revision++;render(value);}},value)),
    React.createElement('div',{style:{width:600,height:600}}, React.createElement(RivalHubRadar,{live,status,resetRevision:revision}))));
}
render('fresh');
`,
);
run(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'build', work], work);
const output = join(root, '.agent-tmp/radar-package');
await mkdir(output, { recursive: true });
await cp(join(work, tarball), join(output, tarball));
const sha256 = createHash('sha256')
  .update(await readFile(join(work, tarball)))
  .digest('hex');
await writeFile(join(output, 'SHA256SUMS'), `${sha256}  ${tarball}\n`);
await writeFile(
  join(output, 'revision.txt'),
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
);
console.log(`Consumer artifact: ${work}`);
