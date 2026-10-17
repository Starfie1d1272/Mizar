/** Test-only counters around the actual production handler and native local bindings.
 * Runs inside workerd so D1 calls stay native; no RPC stand-in for SQLite/R2.
 * The __test routes exist only in this isolated, undeployed measurement module.
 */
import { Miniflare } from 'miniflare';
import { join } from 'node:path';
import { bindings, script } from '../../tests/diagnostics/fixture.ts';
const instrumentation = `
import { handle, cleanup } from './production.mjs';
const counts = { rowsRead:0, rowsWritten:0, queries:0, put:0, head:0, delete:0, get:0, list:0, requests:0 };
const originals = new WeakMap();
function meta(result) {
  counts.queries++;
  counts.rowsRead += result.meta?.rows_read ?? 0;
  counts.rowsWritten += result.meta?.rows_written ?? 0;
  return result;
}
function statement(source) {
  const value = {
    bind(...args) { return statement(source.bind(...args)); },
    async first(column) {
      const rows = meta(await source.all()).results;
      return column ? rows[0]?.[column] ?? null : rows[0] ?? null;
    },
    async all() { return meta(await source.all()); },
    async run() { return meta(await source.run()); }
  };
  originals.set(value, source);
  return value;
}
function observed(environment) {
  const database = environment.DIAGNOSTICS_DB;
  return {
    ...environment,
    DIAGNOSTICS_DB: {
      prepare(sql) { return statement(database.prepare(sql)); },
      async batch(statements) {
        return (await database.batch(statements.map(value => originals.get(value)))).map(meta);
      }
    },
    DIAGNOSTICS_BUCKET: new Proxy(environment.DIAGNOSTICS_BUCKET, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (property in counts) counts[property]++;
          return Reflect.apply(value, target, args);
        };
      }
    }),
    // Only the accelerated storage meter bypasses the native IP limiter.
    // The separate shared-IP scenarios exercise the real configured limiter.
    ENROLL_LIMITER: { limit: async () => ({success:true}) },
    UPLOAD_LIMITER: { limit: async () => ({success:true}) }
  };
}
export default {
  async fetch(request, environment) {
    const url = new URL(request.url);
    if (url.pathname === '/__test/metrics') return Response.json(counts);
    if (url.pathname === '/__test/cleanup') {
      await cleanup(observed(environment), Number(url.searchParams.get('now')));
      return Response.json({done:true});
    }
    counts.requests++;
    return handle(request, observed(environment));
  }
};
`;
export function meteredRuntime(directory) {
  return new Miniflare({
    modules: [
      { type: 'ESModule', path: 'measurement.mjs', contents: instrumentation },
      { type: 'ESModule', path: 'production.mjs', contents: script },
    ],
    compatibilityDate: '2026-07-30',
    bindings: {
      ...bindings,
      DAILY_BYTES: '671088640',
      DAILY_BATCHES: '4800',
      INSTALLATION_DAILY_BYTES: '16777216',
      INSTALLATION_DAILY_BATCHES: '128',
    },
    d1Databases: ['DIAGNOSTICS_DB'],
    d1Persist: join(directory, 'd1'),
    r2Buckets: ['DIAGNOSTICS_BUCKET'],
    r2Persist: join(directory, 'r2'),
  });
}
