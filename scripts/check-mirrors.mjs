import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import https from 'node:https';
import net from 'node:net';

const CANDIDATE_PROXIES = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.org/',
  'https://gh.2i.gs/',
  'https://ghfile.geekertao.top/',
];

const DEFAULT_SAMPLE_BYTES = 262144;
const DEFAULT_TIMEOUT_MS = 8000;
const FULL_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;
const REPO = 'Starfie1d1272/Mizar';

function parseArgs(argv) {
  let full = false;
  let assetName = '';
  let timeoutMs = null;
  let jsonOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') full = true;
    else if (arg === '--json') jsonOnly = true;
    else if (arg === '--asset' && argv[i + 1]) assetName = argv[++i];
    else if (arg === '--timeout' && argv[i + 1]) timeoutMs = Number(argv[++i]);
  }
  return {
    full,
    assetName,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : full
          ? FULL_TIMEOUT_MS
          : DEFAULT_TIMEOUT_MS,
    jsonOnly,
  };
}

function validateHttpsUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error(`Non-HTTPS protocol: ${url.protocol}`);
  if (url.port && url.port !== '443') throw new Error(`Non-default port: ${url.port}`);
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host) !== 0) {
    throw new Error(`Disallowed host: ${host}`);
  }
  return url;
}

function requestHttps(rawUrl, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    const step = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = validateHttpsUrl(currentUrl);
      } catch (err) {
        finish(err);
        return;
      }

      const req = https.get(
        parsed,
        {
          headers: {
            'User-Agent': 'Mizar-Mirror-Check/1.0',
            'Accept-Encoding': 'identity',
            ...headers,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              finish(new Error('Too many redirects'));
              return;
            }
            const nextUrl = new URL(res.headers.location, parsed).toString();
            step(nextUrl, redirectsLeft - 1);
            return;
          }
          finish(null, { res, finalUrl: parsed.toString(), startedAt });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
      req.on('error', (err) => finish(err));
    };

    step(rawUrl, MAX_REDIRECTS);
  });
}

async function fetchLatestReleaseAsset(preferredName) {
  const { res } = await requestHttps(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { Accept: 'application/vnd.github+json' },
    15000,
  );
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  if ((res.statusCode ?? 0) !== 200) {
    throw new Error(`GitHub API returned ${res.statusCode}`);
  }
  const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function isValidContentRange(header, expectedEnd) {
  if (typeof header !== 'string') return false;
  const match = /^bytes\s+0-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return false;
  return Number(match[1]) === expectedEnd;
}

async function probeMirror(proxyPrefix, asset, options) {
  const targetUrl = proxyPrefix ? `${proxyPrefix.replace(/\/+$/, '')}/${asset.url}` : asset.url;
  const label = proxyPrefix || 'direct';
  const startedAt = performance.now();

  try {
    const headers = options.full ? {} : { Range: `bytes=0-${DEFAULT_SAMPLE_BYTES - 1}` };
    const { res, finalUrl } = await requestHttps(targetUrl, headers, options.timeoutMs);
    const statusCode = res.statusCode ?? 0;
    const contentType = String(res.headers['content-type'] || '');
    const contentRange = String(res.headers['content-range'] || '');

    if (contentType.toLowerCase().includes('text/html')) {
      res.destroy();
      return {
        proxy: label,
        ok: false,
        statusCode,
        contentType,
        reason: 'Returned text/html instead of binary asset',
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    if (options.full) {
      if (statusCode !== 200) {
        res.destroy();
        return {
          proxy: label,
          ok: false,
          statusCode,
          contentType,
          reason: `Expected 200 for full download, got ${statusCode}`,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      }
      const hash = createHash('sha256');
      let bytes = 0;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          res.destroy(new Error(`Download timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        res.on('data', (chunk) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const actualSha256 = hash.digest('hex').toLowerCase();
      const shaOk = asset.sha256 ? actualSha256 === asset.sha256 : true;
      const elapsedMs = Math.round(performance.now() - startedAt);
      return {
        proxy: label,
        ok: shaOk && bytes === asset.size,
        mode: 'full',
        statusCode,
        contentType,
        bytes,
        expectedBytes: asset.size,
        sha256Match: shaOk,
        elapsedMs,
        kbps: elapsedMs > 0 ? Math.round(bytes / 1024 / (elapsedMs / 1000)) : null,
        finalUrl,
      };
    }

    // Range probe mode
    const rangeOk =
      statusCode === 206 && isValidContentRange(contentRange, DEFAULT_SAMPLE_BYTES - 1);
    let bytes = 0;
    const sampleChunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        res.destroy(new Error(`Sample read timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      res.on('data', (chunk) => {
        const remaining = DEFAULT_SAMPLE_BYTES - bytes;
        if (remaining > 0) {
          const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          sampleChunks.push(slice);
          bytes += slice.length;
        }
        if (bytes >= DEFAULT_SAMPLE_BYTES) {
          clearTimeout(timer);
          res.destroy();
          resolve();
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      res.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        if (bytes >= DEFAULT_SAMPLE_BYTES) resolve();
        else reject(err);
      });
    });

    const headText = Buffer.concat(sampleChunks)
      .subarray(0, 256)
      .toString('utf8')
      .trimStart()
      .toLowerCase();
    const looksHtml = headText.startsWith('<!doctype html') || headText.startsWith('<html');
    const elapsedMs = Math.round(performance.now() - startedAt);
    const ok = !looksHtml && statusCode === 206 && rangeOk && bytes === DEFAULT_SAMPLE_BYTES;

    return {
      proxy: label,
      ok,
      mode: 'range',
      statusCode,
      range206: statusCode === 206,
      validContentRange: rangeOk,
      contentType,
      contentRange: contentRange || null,
      bytesReceived: bytes,
      elapsedMs,
      kbps: elapsedMs > 0 ? Math.round(bytes / 1024 / (elapsedMs / 1000)) : null,
      reason: ok
        ? null
        : looksHtml
          ? 'Body starts with HTML'
          : statusCode !== 206
            ? `Expected HTTP 206, got ${statusCode}`
            : !rangeOk
              ? `Invalid Content-Range: ${contentRange}`
              : `Received ${bytes} of ${DEFAULT_SAMPLE_BYTES} bytes`,
      finalUrl,
    };
  } catch (err) {
    return {
      proxy: label,
      ok: false,
      mode: options.full ? 'full' : 'range',
      reason: err instanceof Error ? err.message : String(err),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const asset = await fetchLatestReleaseAsset(options.assetName);
  const targets = [null, ...CANDIDATE_PROXIES];
  const results = await Promise.all(targets.map((proxy) => probeMirror(proxy, asset, options)));
  const passedProxies = results
    .filter((r) => r.proxy !== 'direct' && r.ok)
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
    .map((r) => r.proxy);

  const report = {
    checkedAt: new Date().toISOString(),
    release: asset.tagName,
    asset: { name: asset.name, size: asset.size, sha256: asset.sha256, url: asset.url },
    mode: options.full ? 'full' : 'range',
    sampleBytes: options.full ? asset.size : DEFAULT_SAMPLE_BYTES,
    passedProxies,
    results,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
