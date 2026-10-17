import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
// Bundle the actual production entry and shared protocol export, as Wrangler does.
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL('../../apps/diagnostics-worker/src/index.ts', import.meta.url)),
  ],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
export const script = bundled.outputFiles[0]!.text;
const schema = await readFile(
  new URL('../../apps/diagnostics-worker/migrations/0001_diagnostics.sql', import.meta.url),
  'utf8',
);
const statements = schema
  .replace(/^--.*$/gm, '')
  .split(';')
  .map((value) => value.trim())
  .filter(Boolean);
export async function migrate(db: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  await db.batch(statements.map((statement) => db.prepare(statement)));
}
export const bindings = {
  INGEST_SIGNING_KEY: 'public-test-signing-'.repeat(3),
  IP_HASH_KEY: 'public-test-ip-hash-'.repeat(3),
  ADMIN_KEY: 'public-test-admin-'.repeat(3),
  ACCEPTING: '1',
  DATABASE_BYTES: '400000000',
  DAILY_BYTES: '268435456',
  DAILY_BATCHES: '10000',
  DAILY_REGISTRATIONS: '200',
  INSTALLATION_DAILY_BYTES: '16777216',
  INSTALLATION_DAILY_BATCHES: '200',
};
export function runtime(directory: string, uploadLimit = 30) {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    bindings,
    d1Databases: ['DIAGNOSTICS_DB'],
    d1Persist: join(directory, 'd1'),
    r2Buckets: ['DIAGNOSTICS_BUCKET'],
    r2Persist: join(directory, 'r2'),
    ratelimits: {
      ENROLL_LIMITER: { namespace_id: '1001', simple: { limit: 5, period: 60 } },
      UPLOAD_LIMITER: { namespace_id: '1002', simple: { limit: uploadLimit, period: 60 } },
    },
  });
}
export const adminHeaders = { authorization: `Bearer ${bindings.ADMIN_KEY}` };
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
