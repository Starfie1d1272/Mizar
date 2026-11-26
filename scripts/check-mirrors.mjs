import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import {
  fetchHttps,
  fetchJson,
  validateHttpsUrl,
} from '../apps/companion/dist/distribution/http.js';
import { getDistributionConfig } from '../apps/companion/dist/distribution/sources.js';
import { transfer } from '../apps/companion/dist/distribution/transfer.js';

const REPO = 'Starfie1d1272/Mizar';

function parseArgs(argv) {
  let full = false;
  let assetName = '';
  let timeoutMs = null;
  let jsonOnly = false;
  let rounds = 1;
  const extraProxies = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') full = true;
    else if (arg === '--json') jsonOnly = true;
    else if (arg === '--asset' && argv[i + 1]) assetName = argv[++i];
    else if (arg === '--timeout' && argv[i + 1]) timeoutMs = Number(argv[++i]);
    else if (arg === '--rounds' && argv[i + 1]) rounds = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--extra' && argv[i + 1]) extraProxies.push(argv[++i]);
  }

  return { full, assetName, timeoutMs, jsonOnly, rounds, extraProxies };
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

async function probeRange(proxyPrefix, asset, sampleBytes, timeoutMs) {
  const targetUrl = proxyPrefix ? `${proxyPrefix.replace(/\/+$/, '')}/${asset.url}` : asset.url;
  const label = proxyPrefix || 'direct';
  const startedAt = performance.now();
  const sample = Math.min(sampleBytes, asset.size);
  const signal = globalThis.AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetchHttps(targetUrl, {
      signal,
      range: { end: sample - 1 },
      userAgent: 'Mizar-Mirror-Check/2.0',
    });
    const statusCode = response.status;
    const contentType = response.headers.get('content-type') ?? '';
    const contentRange = response.headers.get('content-range') ?? '';

    if (/text\/html/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        proxy: label,
        ok: false,
        mode: 'range',
        statusCode,
        contentType,
        reason: 'Returned text/html instead of binary asset',
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    const expectedRange = `bytes 0-${sample - 1}/${asset.size}`;
    if (statusCode !== 206 || contentRange.trim() !== expectedRange) {
      await response.body?.cancel().catch(() => undefined);
      return {
        proxy: label,
        ok: false,
        mode: 'range',
        statusCode,
        range206: statusCode === 206,
        validContentRange: false,
        contentType,
        contentRange: contentRange || null,
        reason:
          statusCode !== 206
            ? `Expected HTTP 206, got ${statusCode}`
            : `Invalid Content-Range: ${contentRange} (expected ${expectedRange})`,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    const reader = response.body.getReader();
    let bytes = 0;
    const headChunks = [];
    try {
      while (bytes < sample) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done || !chunk.value.length) break;
        const slice =
          chunk.value.length > sample - bytes
            ? chunk.value.subarray(0, sample - bytes)
            : chunk.value;
        if (headChunks.reduce((n, c) => n + c.length, 0) < 256) headChunks.push(slice);
        bytes += slice.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const headText = Buffer.concat(headChunks)
      .subarray(0, 256)
      .toString('utf8')
      .trimStart()
      .toLowerCase();
    const looksHtml = headText.startsWith('<!doctype html') || headText.startsWith('<html');
    const elapsedMs = Math.round(performance.now() - startedAt);
    const ok = !looksHtml && bytes === sample;

    return {
      proxy: label,
      ok,
      mode: 'range',
      statusCode,
      range206: true,
      validContentRange: true,
      contentType,
      contentRange,
      bytesReceived: bytes,
      elapsedMs,
      kbps: elapsedMs > 0 ? Math.round(bytes / 1024 / (elapsedMs / 1000)) : null,
      reason: ok
        ? null
        : looksHtml
          ? 'Body starts with HTML'
          : `Received ${bytes} of ${sample} bytes`,
    };
  } catch (error) {
    return {
      proxy: label,
      ok: false,
      mode: 'range',
      reason: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }
}

async function probeFull(proxyPrefix, asset, timeoutMs) {
  const targetUrl = proxyPrefix ? `${proxyPrefix.replace(/\/+$/, '')}/${asset.url}` : asset.url;
  const label = proxyPrefix || 'direct';
  const startedAt = performance.now();
  const dir = await mkdtemp(join(tmpdir(), 'mizar-mirror-full-'));
  const target = join(dir, 'asset.bin');

  try {
    if (!asset.sha256) {
      const response = await fetchHttps(targetUrl, {
        signal: globalThis.AbortSignal.timeout(timeoutMs),
        userAgent: 'Mizar-Mirror-Check/2.0',
      });
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      return {
        proxy: label,
        ok: bytes === asset.size,
        mode: 'full',
        bytes,
        expectedBytes: asset.size,
        expectedSha256: null,
        sha256Verified: false,
        elapsedMs,
      };
    }

    const result = await transfer({
      target,
      bytes: asset.size,
      sha256: asset.sha256,
      signal: globalThis.AbortSignal.timeout(timeoutMs),
      sources: [(signal) => fetchHttps(targetUrl, { signal, userAgent: 'Mizar-Mirror-Check/2.0' })],
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    return {
      proxy: label,
      ok: true,
      mode: 'full',
      bytes: result.bytes,
      expectedBytes: asset.size,
      expectedSha256: asset.sha256,
      sha256Verified: true,
      sha256Match: true,
      elapsedMs,
      kbps: elapsedMs > 0 ? Math.round(result.bytes / 1024 / (elapsedMs / 1000)) : null,
    };
  } catch (error) {
    return {
      proxy: label,
      ok: false,
      mode: 'full',
      expectedSha256: asset.sha256,
      sha256Verified: Boolean(asset.sha256),
      sha256Match: asset.sha256 ? false : undefined,
      reason: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function formatTable(roundResults) {
  const rows = roundResults.map((r) => [
    r.proxy,
    r.ok ? 'PASS' : 'FAIL',
    String(r.statusCode ?? '-'),
    `${r.elapsedMs}ms`,
    r.kbps != null ? `${r.kbps} KiB/s` : '-',
    r.reason ?? 'ok',
  ]);
  const header = ['Source', 'Result', 'HTTP', 'Elapsed', 'Speed', 'Detail'];
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return all.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ')).join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = getDistributionConfig();
  const sampleBytes = config.probe.sampleBytes;
  const timeoutMs =
    options.timeoutMs && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : options.full
        ? 120_000
        : config.probe.timeoutMs;

  const candidateProxies = [...new Set([...config.githubReleaseProxies, ...options.extraProxies])];
  for (const proxy of candidateProxies) validateHttpsUrl(proxy);

  const asset = await fetchLatestReleaseAsset(options.assetName);
  const targets = [null, ...candidateProxies];
  const rounds = [];

  for (let round = 1; round <= options.rounds; round += 1) {
    if (round > 1) await delay(3000);
    const results = await Promise.all(
      targets.map((proxy) =>
        options.full
          ? probeFull(proxy, asset, timeoutMs)
          : probeRange(proxy, asset, sampleBytes, timeoutMs),
      ),
    );
    rounds.push({ round, results });
    if (!options.jsonOnly) {
      console.log(`\n=== Round ${round}/${options.rounds} (${asset.tagName} ${asset.name}) ===`);
      console.log(formatTable(results));
    }
  }

  const summaryByProxy = candidateProxies.map((proxy) => {
    const entries = rounds.map((r) => r.results.find((item) => item.proxy === proxy));
    const passes = entries.filter((e) => e?.ok).length;
    const avgMs =
      passes > 0
        ? Math.round(entries.filter((e) => e?.ok).reduce((sum, e) => sum + e.elapsedMs, 0) / passes)
        : null;
    return { proxy, passes, totalRounds: options.rounds, avgMs };
  });

  const report = {
    checkedAt: new Date().toISOString(),
    release: asset.tagName,
    asset: { name: asset.name, size: asset.size, sha256: asset.sha256, url: asset.url },
    mode: options.full ? 'full' : 'range',
    sampleBytes: options.full ? asset.size : sampleBytes,
    timeoutMs,
    summaryByProxy,
    rounds,
  };

  if (options.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Summary JSON ===');
    console.log(JSON.stringify(report.summaryByProxy, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
