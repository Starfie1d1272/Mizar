import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  fetchHttps,
  fetchJson,
  validateHttpsUrl,
} from '../apps/companion/dist/distribution/http.js';
import {
  buildGitHubReleaseSources,
  getDistributionConfig,
  probeSource,
} from '../apps/companion/dist/distribution/sources.js';
import { transfer } from '../apps/companion/dist/distribution/transfer.js';

const REPO = 'Starfie1d1272/Mizar';

function parseArgs(argv) {
  let full = false;
  let assetName = '';
  let jsonOnly = false;
  let rounds = 1;
  const extraProxies = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') full = true;
    else if (arg === '--json') jsonOnly = true;
    else if (arg === '--asset' && argv[i + 1]) assetName = argv[++i];
    else if (arg === '--rounds' && argv[i + 1]) rounds = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--extra' && argv[i + 1]) extraProxies.push(argv[++i]);
  }
  return { full, assetName, jsonOnly, rounds, extraProxies };
}

async function fetchLatestReleaseAsset(preferredName) {
  const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`, {
    signal: globalThis.AbortSignal.timeout(15_000),
    headers: { Accept: 'application/vnd.github+json' },
    maxBytes: 512 * 1024,
  });
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = preferredName
    ? assets.find((a) => a.name === preferredName)
    : assets.find((a) => a.name.endsWith('-Core-Setup.exe')) ||
      assets.find((a) => a.name.endsWith('.zip')) ||
      assets[0];
  if (!asset) throw new Error('No matching release asset found');
  const sha256 =
    typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
      ? asset.digest.slice('sha256:'.length).toLowerCase()
      : null;
  return {
    tagName: release.tagName ?? release.tag_name,
    name: asset.name,
    size: asset.size,
    sha256,
    url: asset.browser_download_url,
  };
}

async function runFullSource(source, asset) {
  if (!asset.sha256)
    throw new Error(`Asset ${asset.name} has no expected sha256 for --full verification`);
  const dir = await mkdtemp(join(tmpdir(), 'mizar-mirror-full-'));
  const startedAt = Date.now();
  try {
    await transfer({
      target: join(dir, 'asset.bin'),
      bytes: asset.size,
      sha256: asset.sha256,
      signal: globalThis.AbortSignal.timeout(120_000),
      sources: [source],
    });
    return { source: source.name, ok: true, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      source: source.name,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = getDistributionConfig();
  const extraProxies = options.extraProxies.filter((p) => !config.githubReleaseProxies.includes(p));
  const asset = await fetchLatestReleaseAsset(options.assetName);
  const sources = [
    ...buildGitHubReleaseSources(asset.url),
    ...extraProxies.map((proxy) => {
      const proxyUrl = validateHttpsUrl(proxy);
      const prefix = proxyUrl.href.replace(/\/+$/, '');
      return {
        name: `GitHub 加速 (${proxyUrl.hostname})`,
        request: (signal, rangeEnd) =>
          fetchHttps(`${prefix}/${asset.url}`, {
            signal,
            ...(rangeEnd === undefined ? {} : { range: { end: rangeEnd } }),
          }),
      };
    }),
  ];

  const rounds = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    if (round > 1) await delay(3000);
    const results = await Promise.all(
      sources.map(async (source) => {
        if (options.full) return runFullSource(source, asset);
        const r = await probeSource(asset.size, new globalThis.AbortController().signal, source);
        const sample = Math.min(config.probe.sampleBytes, asset.size);
        return {
          source: source.name,
          ok: r.ok,
          status: r.status ?? null,
          rangeIgnored: r.rangeIgnored ?? false,
          elapsedMs: r.elapsedMs,
          kbps: r.ok && r.elapsedMs > 0 ? Math.round(sample / 1024 / (r.elapsedMs / 1000)) : null,
          reason: r.ok
            ? null
            : r.error instanceof Error
              ? r.error.message
              : String(r.error ?? 'failed'),
        };
      }),
    );
    rounds.push({ round, results });
    if (!options.jsonOnly) {
      console.log(`\n=== Round ${round}/${options.rounds} (${asset.tagName} ${asset.name}) ===`);
      console.table(results);
    }
  }

  if (options.jsonOnly) {
    console.log(
      JSON.stringify(
        { checkedAt: new Date().toISOString(), release: asset.tagName, asset: asset.name, rounds },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
