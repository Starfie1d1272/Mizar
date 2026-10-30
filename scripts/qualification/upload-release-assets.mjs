import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Each upload is independently bounded; a failed batch joins all in-flight writes
// and never retries. The next authorized run reconciles the public original bytes.
export async function uploadReleaseAssets(tag, paths, execute = promisify(execFile)) {
  if (
    !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.test(tag) ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some((path) => typeof path !== 'string' || !path) ||
    new Set(paths.map((path) => basename(path))).size !== paths.length
  )
    throw new Error('Invalid release asset inventory');
  for (let offset = 0; offset < paths.length; offset += 3) {
    const results = await Promise.allSettled(
      paths.slice(offset, offset + 3).map(async (path) => {
        const name = basename(path),
          started = globalThis.performance.now();
        console.log(`GH 上传 ${name} 开始 attempt=1 deadline_ms=180000`);
        try {
          await execute('gh', ['release', 'upload', tag, path, '--repo', 'Starfie1d1272/Mizar'], {
            timeout: 180000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
          });
          console.log(
            `GH 上传 ${name} 完成 elapsed_ms=${Math.round(globalThis.performance.now() - started)}`,
          );
        } catch {
          console.log(
            `GH 上传 ${name} 失败 elapsed_ms=${Math.round(globalThis.performance.now() - started)}；结果需核对`,
          );
          throw new Error(`Upload outcome unknown: ${name}`);
        }
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, ...paths] = process.argv.slice(2);
  await uploadReleaseAssets(tag, paths);
}
