import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? join(root, '.agent-tmp/hud-reference'));
const name = 'perfectworld-hud-reference';
const pack = join(output, name);
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const { build } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const assetManifest = JSON.parse(
  await readFile(join(root, 'packages/cs2-assets/generated/manifest.json'), 'utf8'),
);
const embeddedMasks = new Map();
for (const asset of Object.values(assetManifest.assets)) {
  if (asset.mediaType !== 'image/svg+xml') continue;
  const svg = await readFile(
    join(root, 'packages/cs2-assets/generated/public', asset.outputPath),
    'utf8',
  );
  embeddedMasks.set(asset.outputPath, `data:image/svg+xml,${encodeURIComponent(svg)}`);
}
await rm(pack, { recursive: true, force: true });
await mkdir(pack, { recursive: true });
await build({
  configFile: false,
  root: join(root, 'apps/web'),
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [
    {
      name: 'offline-reference-paths',
      enforce: 'pre',
      transform(code, id) {
        if (id.includes('node_modules')) return null;
        if (id.endsWith('/generated/manifest.json')) {
          for (const [path, data] of embeddedMasks)
            code = code.replaceAll(JSON.stringify(path), JSON.stringify(data));
        }
        if (id.endsWith('/widgets/radar/Radar.tsx'))
          code = code.replace('assetBaseUrl="/"', 'assetBaseUrl="./"');
        return code.replaceAll('"/assets/', '"./assets/').replaceAll("'/assets/", "'./assets/");
      },
    },
  ],
  build: {
    outDir: pack,
    emptyOutDir: false,
    lib: {
      entry: join(root, 'apps/web/src/reference/perfectworld.tsx'),
      name: 'PerfectworldReference',
      formats: ['iife'],
      fileName: () => 'preview.js',
      cssFileName: 'preview',
    },
    assetsInlineLimit: 0,
  },
});
const html =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Perfect World HUD reference</title><link rel="stylesheet" href="preview.css"><div id="root"></div><script src="preview.js"></script></html>\n';
await writeFile(join(pack, 'index.html'), html);
// Embed fonts and SVG masks so file:// does not need cross-origin resource access.
const stylesheet = join(pack, 'preview.css');
const font = await readFile(
  join(root, 'apps/web/public/brand/fonts/barlow-condensed/BarlowCondensed-Bold.ttf'),
);
await writeFile(
  stylesheet,
  (await readFile(stylesheet, 'utf8'))
    .replaceAll(
      '/brand/fonts/barlow-condensed/BarlowCondensed-Bold.ttf',
      `data:font/ttf;base64,${font.toString('base64')}`,
    )
    .replaceAll('/brand/', './brand/'),
);
for (const [source, target] of [
  ['packages/cs2-assets/generated/public/assets', 'assets'],
  ['packages/radar-view/dist/assets/assets', 'assets'],
  ['apps/web/public/brand', 'brand'],
  ['apps/web/public/fixtures/ancient-round-03/assets', 'fixtures/ancient-round-03/assets'],
  ['scripts/hud-reference/serve-preview.mjs', 'serve-preview.mjs'],
  ['LICENSE', 'LICENSE'],
  ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
  ['docs/examples/perfectworld.mizar-hud.json', 'perfectworld.mizar-hud.json'],
])
  await cp(join(root, source), join(pack, target), { recursive: true });
for (const source of [
  'apps/web/src/program',
  'apps/web/src/reference',
  'packages/hud-config/src',
  'packages/cs2-assets/src',
  'packages/cs2-assets/catalog',
  'packages/cs2-assets/generated/manifest.json',
  'packages/design-tokens/generated/tokens.css',
  'packages/radar-view/src',
  'packages/protocol/src',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'scripts/hud-reference/build-perfectworld.mjs',
]) {
  await mkdir(dirname(join(pack, 'source', source)), { recursive: true });
  await cp(join(root, source), join(pack, 'source', source), { recursive: true });
}
let executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) {
  try {
    await access('/usr/bin/chromium');
    executablePath = '/usr/bin/chromium';
  } catch {
    /* Use Playwright's installed browser. */
  }
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      pack,
      '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname),
    );
    const local = relative(pack, path);
    if (local.startsWith('..') || isAbsolute(local)) {
      response.writeHead(403).end();
      return;
    }
    const file = path.endsWith('/') ? path + 'index.html' : path;
    response.setHeader(
      'Content-Type',
      types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/'))
      errors.push(`Unexpected network request: ${request.url()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  await page.goto(origin + '/index.html');
  await page.locator('.gameplay-hud').waitFor();
  const reference = await page.evaluate('window.perfectworldReference');
  await mkdir(join(pack, 'markup'), { recursive: true });
  await writeFile(join(pack, 'fixtures.json'), JSON.stringify(reference, null, 2));
  for (let index = 0; index < reference.samples.length; index++) {
    await page.getByLabel('参考场景').selectOption(String(index));
    await page.waitForFunction("!document.querySelector('.focused-player__face--pending')");
    await page.evaluate('document.fonts.ready.then(() => true)');
    const markup = await page.locator('.gameplay-hud').evaluate((element) => element.outerHTML);
    await writeFile(join(pack, 'markup', `${reference.samples[index].id}.html`), markup);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await cp(join(root, 'scripts/hud-reference/README.md'), join(pack, 'README.md'));
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name), path)));
    else result.push(path);
  }
  return result.sort();
}
const hashes = {};
for (const path of await files(pack))
  hashes[path] = createHash('sha256')
    .update(await readFile(join(pack, path)))
    .digest('hex');
await writeFile(
  join(pack, 'manifest.json'),
  JSON.stringify(
    {
      sourceCommit: commit,
      dirtySource:
        execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !==
        '',
      purpose: 'offline-visual-reference',
      files: hashes,
    },
    null,
    2,
  ),
);
const archive = join(output, `${name}.zip`);
await rm(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, name], { cwd: output });
console.log(
  `ZIP: ${archive}\nSHA-256: ${createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')}`,
);
