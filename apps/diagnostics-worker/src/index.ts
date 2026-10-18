import {
  DIAGNOSTIC_BODY_LIFETIME_MS,
  DIAGNOSTIC_AUTOMATIC_LIFETIME_MS,
  DIAGNOSTIC_CLOCK_SKEW_MS,
  diagnosticInstallationCreatedAt,
  diagnosticAutomaticTimeReason,
  diagnosticPermitClaims,
  readDiagnosticGzipPermit,
  type DiagnosticUploadPermit,
} from '@mizar/protocol/diagnostics-upload';
import { DIAGNOSTIC_CONSENT_REVISION } from '@mizar/protocol/version';
/** Private diagnostic ingestion. Bodies are already redacted/compressed by the opted-in client.
 * No body inflation, public object URL, runtime management token, or business-state interpretation. */
export interface Env {
  DIAGNOSTICS_DB: D1Database;
  DIAGNOSTICS_BUCKET: R2Bucket;
  ENROLL_LIMITER: RateLimit;
  UPLOAD_LIMITER: RateLimit;
  INGEST_SIGNING_KEY: string;
  IP_HASH_KEY: string;
  ADMIN_KEY: string;
  ACCEPTING: string;
  DAILY_BYTES: string;
  DAILY_BATCHES: string;
  DAILY_REGISTRATIONS: string;
  INSTALLATION_DAILY_BYTES: string;
  INSTALLATION_DAILY_BATCHES: string;
  DATABASE_BYTES: string;
}
const DAY = 86400_000;
export const LIMITS = {
  compressedBytes: 512 * 1024,
  expandedBytes: 4 * 1024 * 1024,
  events: 4096,
  metadataBytes: 4096,
  bodyDays: 7,
  indexDays: 90,
  cleanupObjects: 100,
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const sql = (env: Env, query: string, ...values: (string | number | null | ArrayBuffer)[]) =>
  env.DIAGNOSTICS_DB.prepare(query).bind(...values);
const binaryId = (value: string) =>
  Uint8Array.from(value.replaceAll('-', '').match(/../g)!, (byte) => parseInt(byte, 16)).buffer;
interface PermitRow {
  installation_hex: string;
  installation_created_at: number;
  consent_revision: string;
  issued_at: number;
  payload_created_at: number;
  retire_at: number;
  wire_hex: string;
}
const permitStatement = (env: Env, payload: string) =>
  sql(
    env,
    `SELECT lower(hex(installation_id)) AS installation_hex, installation_created_at, consent_revision,
    issued_at, payload_created_at, retire_at, lower(hex(wire_sha256)) AS wire_hex FROM upload_permits WHERE payload_sha256=?`,
    binaryId(payload),
  );
const permitRow = (env: Env, payload: string) => permitStatement(env, payload).first<PermitRow>();

const budget = (value: string) => (/^\d{1,12}$/.test(value) ? Number(value) : 0);
async function withinDatabaseBudget(env: Env) {
  const probe = await sql(env, 'SELECT 1').run();
  return probe.meta.size_after < budget(env.DATABASE_BYTES);
}
async function hash(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
// The isolate only uses the two environment signing secrets. Bound the cache
// across rotations/test environments; changing a secret always imports a new key.
const macKeys = new Map<string, Promise<CryptoKey>>();
async function mac(secret: string, value: string) {
  let pending = macKeys.get(secret);
  if (!pending) {
    if (macKeys.size >= 2) macKeys.clear();
    pending = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    macKeys.set(secret, pending);
  }
  let key: CryptoKey;
  try {
    key = await pending;
  } catch (error) {
    if (macKeys.get(secret) === pending) macKeys.delete(secret);
    throw error;
  }
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
function equal(left: string, right: string) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index++)
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}
async function issued(env: Env, id: string, now: number, deletion = false) {
  const birth = diagnosticInstallationCreatedAt(id);
  const expiresAt = deletion
    ? now + 30 * DAY
    : Math.min(now + 30 * DAY, (birth ?? 0) + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS);
  const claims = `${id}.${Math.floor(expiresAt / 1000)}`;
  return {
    installationId: id,
    token: `${claims}.${base64(await mac(env.INGEST_SIGNING_KEY, claims))}`,
    expiresAt,
  };
}
async function authenticate(request: Request, env: Env, now: number, allowRevoked = false) {
  const parts = request.headers
    .get('authorization')
    ?.replace(/^Bearer /, '')
    .split('.');
  if (
    !parts ||
    parts.length !== 3 ||
    !uuid.test(parts[0]!) ||
    !/^\d{10}$/.test(parts[1]!) ||
    Number(parts[1]) * 1000 <= now
  )
    return null;
  const birth = diagnosticInstallationCreatedAt(parts[0]!);
  if (
    !allowRevoked &&
    (birth === null ||
      birth > now + DIAGNOSTIC_CLOCK_SKEW_MS ||
      birth + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS <= now)
  )
    return null;
  const expected = base64(await mac(env.INGEST_SIGNING_KEY, `${parts[0]}.${parts[1]}`));
  if (!equal(parts[2]!, expected)) return null;
  const row = await sql(
    env,
    'SELECT id,revoked_at FROM installations WHERE id=?',
    parts[0]!,
  ).first<{ id: string; revoked_at: number | null }>();
  return row && (allowRevoked || row.revoked_at === null) ? row.id : null;
}
async function bounded(stream: ReadableStream<Uint8Array> | null, maximum: number) {
  if (!stream) throw new Error('missing_body');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = AbortSignal.timeout(15_000);
  const cancel = () => {
    void reader.cancel('body_timeout');
  };
  timeout.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const item = await reader.read();
      if (timeout.aborted) throw new Error('body_timeout');
      if (item.done) break;
      size += item.value.length;
      if (size > maximum) throw new Error('body_too_large');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    timeout.removeEventListener('abort', cancel);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
interface Metadata {
  schema: 'mizar-technical-diagnostics/1';
  events: number;
  expandedBytes: number;
  stages: string[];
  sessionId: string | null;
  from: string | null;
  to: string | null;
  version: string | null;
  failures: number;
  failureKinds: string[];
  sourceTimeUnknownRecords: number;
}
function metadata(text: string | null): Metadata | null {
  if (!text || encoder.encode(text).length > LIMITS.metadataBytes) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (key) =>
        ![
          'schema',
          'events',
          'expandedBytes',
          'stages',
          'sessionId',
          'from',
          'to',
          'version',
          'failures',
          'failureKinds',
          'sourceTimeUnknownRecords',
        ].includes(key),
    ) ||
    value.schema !== 'mizar-technical-diagnostics/1' ||
    !Number.isSafeInteger(value.events) ||
    Number(value.events) < 1 ||
    Number(value.events) > LIMITS.events ||
    !Number.isSafeInteger(value.expandedBytes) ||
    Number(value.expandedBytes) < 1 ||
    Number(value.expandedBytes) > LIMITS.expandedBytes ||
    !Array.isArray(value.stages) ||
    value.stages.length > 32 ||
    value.stages.some((stage) => typeof stage !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(stage))
  )
    return null;
  const time = (value: unknown) =>
    value == null ||
    (typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)));
  if (
    (value.sessionId != null &&
      (typeof value.sessionId !== 'string' || !uuid.test(value.sessionId))) ||
    !time(value.from) ||
    !time(value.to) ||
    (value.version != null &&
      (typeof value.version !== 'string' || !/^[a-zA-Z0-9.+_-]{1,64}$/.test(value.version))) ||
    (value.failures != null &&
      (!Number.isSafeInteger(value.failures) ||
        Number(value.failures) < 0 ||
        Number(value.failures) > Number(value.events)))
  )
    return null;
  if (
    (value.failureKinds !== undefined &&
      (!Array.isArray(value.failureKinds) ||
        value.failureKinds.length > 16 ||
        value.failureKinds.some(
          (kind) => typeof kind !== 'string' || !/^[a-z_]{1,32}$/.test(kind),
        ))) ||
    (value.sourceTimeUnknownRecords !== undefined &&
      (!Number.isSafeInteger(value.sourceTimeUnknownRecords) ||
        Number(value.sourceTimeUnknownRecords) < 0 ||
        Number(value.sourceTimeUnknownRecords) > Number(value.events)))
  )
    return null;
  return {
    schema: value.schema,
    events: Number(value.events),
    expandedBytes: Number(value.expandedBytes),
    stages: value.stages as string[],
    sessionId: (value.sessionId as string) ?? null,
    from: (value.from as string) ?? null,
    to: (value.to as string) ?? null,
    version: (value.version as string) ?? null,
    failures: Number(value.failures ?? 0),
    failureKinds: (value.failureKinds as string[] | undefined) ?? [],
    sourceTimeUnknownRecords: Number(value.sourceTimeUnknownRecords ?? 0),
  };
}
interface BatchRow {
  id: string;
  installation_id: string;
  object_key: string;
  owner: string;
  state: string;
  writers: number;
  bytes: number;
  received_at: number;
  expires_at: number;
  metadata: string;
}
const batchStatement = (env: Env, installation: string, id: string) =>
  sql(env, 'SELECT * FROM batches WHERE installation_id=? AND id=?', installation, id);
const batchRow = (env: Env, installation: string, id: string) =>
  batchStatement(env, installation, id).first<BatchRow>();
const accepted = (id: string) => json({ batchId: id, sha256: id, accepted: true });
async function enroll(request: Request, env: Env, now: number) {
  const value = JSON.parse(new TextDecoder().decode(await bounded(request.body, 512))) as Record<
    string,
    unknown
  >;
  if (
    !value ||
    value.consent !== DIAGNOSTIC_CONSENT_REVISION ||
    typeof value.enrollmentId !== 'string' ||
    !uuid.test(value.enrollmentId) ||
    typeof value.enrollmentSecret !== 'string' ||
    !digest.test(value.enrollmentSecret)
  )
    return json({ error: 'enrollment_proof_required' }, 400);
  const id = value.enrollmentId;
  const deletion = value.deletion === true;
  const birth = diagnosticInstallationCreatedAt(id);
  if (!deletion) {
    const reason =
      birth === null
        ? 'installation_identity_unverifiable'
        : birth > now + DIAGNOSTIC_CLOCK_SKEW_MS
          ? 'installation_clock_future'
          : birth + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS <= now
            ? 'installation_lease_closed'
            : null;
    if (reason) return json({ error: reason }, 410);
  }
  const proof = await hash(encoder.encode(value.enrollmentSecret));
  const prior = await sql(
    env,
    'SELECT proof_sha256,revoked_at FROM installations WHERE id=?',
    id,
  ).first<{ proof_sha256: string; revoked_at: number | null }>();
  // Proof holders can renew a deletion token; renewal never clears revocation.
  if (prior)
    return equal(prior.proof_sha256, proof)
      ? json(await issued(env, id, now, deletion))
      : json({ error: 'enrollment_conflict' }, 409);
  if (deletion) {
    const orphan = await sql(
      env,
      `SELECT 1 AS present FROM batches WHERE installation_id=? UNION ALL SELECT 1 FROM sessions WHERE installation_id=? LIMIT 1`,
      id,
      id,
    ).first();
    return orphan
      ? json({ error: 'deletion_unconfirmed' }, 503)
      : json({ installationId: id, revoked: true, deletion: 'complete', closed: true });
  }
  if (env.ACCEPTING !== '1') return json({ error: 'intake_paused' }, 503);
  if (!(await withinDatabaseBudget(env))) return json({ error: 'index_allocation_budget' }, 503);
  const day = Math.floor(now / DAY);
  await sql(env, 'INSERT OR IGNORE INTO daily(day) VALUES(?)', day).run();
  const result = await env.DIAGNOSTICS_DB.batch([
    sql(
      env,
      `INSERT OR IGNORE INTO installations(id,proof_sha256,created_at,lease_expires_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM daily WHERE day=? AND registrations<?)`,
      id,
      proof,
      now,
      birth! + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS,
      day,
      budget(env.DAILY_REGISTRATIONS),
    ),
    sql(
      env,
      `UPDATE daily SET registrations=registrations+1 WHERE day=? AND
      EXISTS(SELECT 1 FROM installations WHERE id=? AND created_at=? AND proof_sha256=?)`,
      day,
      id,
      now,
      proof,
    ),
  ]);
  if (!result[0]?.meta.changes) return json({ error: 'registration_budget' }, 429);
  return json(await issued(env, id, now));
}
async function upload(request: Request, env: Env, id: string, installation: string, now: number) {
  if (env.ACCEPTING !== '1') return json({ error: 'intake_paused' }, 503);
  const index = metadata(request.headers.get('x-diagnostics-index'));
  if (
    !index ||
    request.headers.get('content-type') !== 'application/gzip' ||
    request.headers.get('x-content-sha256') !== id
  )
    return json({ error: 'invalid_batch_metadata' }, 400);
  if (Number(request.headers.get('content-length')) > LIMITS.compressedBytes)
    return json({ error: 'body_too_large' }, 413);
  const bytes = await bounded(request.body, LIMITS.compressedBytes);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || (await hash(bytes)) !== id)
    return json({ error: 'batch_integrity' }, 400);
  const sealed = readDiagnosticGzipPermit(bytes);
  if (
    !sealed ||
    sealed.permit.installationId !== installation ||
    sealed.permit.issuedAt > now ||
    !equal(
      sealed.permit.signature,
      base64(await mac(env.INGEST_SIGNING_KEY, diagnosticPermitClaims(sealed.permit))),
    ) ||
    (await hash(sealed.payload)) !== sealed.permit.payloadSha256
  )
    return json({ error: 'invalid_batch_permit' }, 400);
  if (sealed.permit.expiresAt <= now) return json({ error: 'batch_retention_expired' }, 410);
  const preflight = await env.DIAGNOSTICS_DB.batch<unknown>([
    permitStatement(env, sealed.permit.payloadSha256),
    batchStatement(env, installation, id),
  ]);
  const firstPermit = preflight[0]?.results[0] as PermitRow | undefined;
  if (
    !firstPermit ||
    firstPermit.installation_hex !== installation.replaceAll('-', '') ||
    firstPermit.installation_created_at !== sealed.permit.installationCreatedAt ||
    firstPermit.consent_revision !== sealed.permit.consentRevision ||
    firstPermit.issued_at !== sealed.permit.issuedAt ||
    firstPermit.payload_created_at !== sealed.permit.payloadCreatedAt
  )
    return json({ error: 'invalid_batch_permit' }, 400);
  if (firstPermit.wire_hex && firstPermit.wire_hex !== id)
    return json({ error: 'payload_encoding_conflict' }, 409);
  if (
    bytes.length > budget(env.INSTALLATION_DAILY_BYTES) ||
    !budget(env.INSTALLATION_DAILY_BATCHES)
  )
    return json({ error: 'installation_capacity' }, 429);
  const existing = preflight[1]?.results[0] as BatchRow | undefined;
  if (existing && existing.expires_at <= now)
    return json({ error: 'batch_retention_expired' }, 410);
  if (existing?.state === 'ready') return accepted(id);
  if (!(preflight[1]!.meta.size_after < budget(env.DATABASE_BYTES)))
    return json({ error: 'index_allocation_budget' }, 503);
  const boundPermit = await sql(
    env,
    `UPDATE upload_permits SET wire_sha256=? WHERE payload_sha256=? AND wire_sha256 IS NULL
    RETURNING lower(hex(wire_sha256)) AS wire_hex`,
    binaryId(id),
    binaryId(sealed.permit.payloadSha256),
  ).first<{ wire_hex: string }>();
  // A concurrent writer or retry can already have bound it. Re-read that case
  // while the common first binding uses the atomic UPDATE result directly.
  const wireHex =
    boundPermit?.wire_hex ?? (await permitRow(env, sealed.permit.payloadSha256))?.wire_hex;
  if (wireHex !== id) return json({ error: 'payload_encoding_conflict' }, 409);

  if (existing && (existing.state === 'deleting' || existing.writers >= 8))
    return json({ error: 'batch_pending' }, 409);
  const owner = crypto.randomUUID();
  const day = Math.floor(now / DAY);
  const objectKey = `v1/${installation}/${day}/${id}.gz`;
  // D1 batch is one transaction. A rejected reservation mutates no quota.
  const reserved = await env.DIAGNOSTICS_DB.batch<unknown>([
    sql(env, 'INSERT OR IGNORE INTO daily(day) VALUES(?)', day),
    sql(
      env,
      `INSERT INTO batches(installation_id,id,object_key,owner,state,bytes,received_at,expires_at,metadata)
      SELECT ?,?,?,?,'pending',?,?,?,? WHERE
      EXISTS(SELECT 1 FROM installations WHERE id=? AND revoked_at IS NULL AND
        (quota_day!=? OR (quota_bytes+?<=? AND quota_batches<?))) AND
      EXISTS(SELECT 1 FROM daily WHERE day=? AND bytes+?<=? AND batches<?)
      ON CONFLICT(installation_id,id) DO UPDATE SET owner=excluded.owner,state='pending',writers=batches.writers+1
      WHERE batches.state IN ('failed','pending') AND batches.writers<8`,
      installation,
      id,
      objectKey,
      owner,
      bytes.length,
      now,
      sealed.permit.expiresAt,
      JSON.stringify(index),
      installation,
      day,
      bytes.length,
      budget(env.INSTALLATION_DAILY_BYTES),
      budget(env.INSTALLATION_DAILY_BATCHES),
      day,
      bytes.length,
      budget(env.DAILY_BYTES),
      budget(env.DAILY_BATCHES),
    ),
    sql(
      env,
      `UPDATE daily SET bytes=bytes+?,batches=batches+1 WHERE day=? AND
      EXISTS(SELECT 1 FROM batches WHERE installation_id=? AND id=? AND owner=?)`,
      bytes.length,
      day,
      installation,
      id,
      owner,
    ),
    sql(
      env,
      `UPDATE installations SET quota_bytes=CASE WHEN quota_day=? THEN quota_bytes+? ELSE ? END,
      quota_batches=CASE WHEN quota_day=? THEN quota_batches+1 ELSE 1 END,
      quota_permits=CASE WHEN quota_day=? THEN quota_permits ELSE 0 END,quota_day=? WHERE id=? AND
      EXISTS(SELECT 1 FROM batches WHERE installation_id=? AND id=? AND owner=?)`,
      day,
      bytes.length,
      bytes.length,
      day,
      day,
      day,
      installation,
      installation,
      id,
      owner,
    ),
    batchStatement(env, installation, id),
  ]);
  if (!reserved[1]?.meta.changes) return json({ error: 'capacity_or_concurrent_reservation' }, 429);
  let row: BatchRow | null = null;
  try {
    row = (reserved[4]?.results[0] as BatchRow | undefined) ?? null;
    if (!row || row.owner !== owner) return json({ error: 'reservation_unconfirmed' }, 503);
    // Never overwrite an acknowledged/retried object and reset its original retention clock.
    const created = await env.DIAGNOSTICS_BUCKET.put(row.object_key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { sha256: id, installation, expiresAt: String(row.expires_at) },
    });
    // A successful conditional write already supplies the object metadata. Only
    // retries/competing writers need a HEAD; the existing retention clock stays intact.
    const object = created ?? (await env.DIAGNOSTICS_BUCKET.head(row.object_key));
    if (!object || object.size !== bytes.length || object.customMetadata?.sha256 !== id)
      throw new Error('existing_object_integrity');
    const revoked = await sql(
      env,
      'SELECT revoked_at FROM installations WHERE id=?',
      installation,
    ).first<{ revoked_at: number | null }>();
    if (!revoked || revoked.revoked_at !== null || row.expires_at <= Date.now()) {
      await env.DIAGNOSTICS_BUCKET.delete(row.object_key);
      await sql(
        env,
        "UPDATE batches SET state='failed' WHERE installation_id=? AND id=? AND owner=?",
        installation,
        id,
        owner,
      ).run();
      return json({ error: 'installation_revoked_or_batch_expired' }, 410);
    }
    const storedIndex = metadata(row.metadata)!;
    const finalized = await env.DIAGNOSTICS_DB.batch<unknown>([
      sql(
        env,
        `INSERT INTO sessions(installation_id,session_id,first_received_at,last_received_at,source_from,source_to,version,events,failures,failure_kinds,source_time_unknown,batches,bytes,expires_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,1,?,? WHERE EXISTS(SELECT 1 FROM batches WHERE installation_id=? AND id=? AND owner=? AND state='pending')
        AND EXISTS(SELECT 1 FROM installations WHERE id=? AND revoked_at IS NULL)
        ON CONFLICT(installation_id,session_id) DO UPDATE SET last_received_at=MAX(sessions.last_received_at,excluded.last_received_at),
        source_from=CASE WHEN sessions.source_from IS NULL THEN excluded.source_from ELSE MIN(sessions.source_from,COALESCE(excluded.source_from,sessions.source_from)) END,source_to=CASE WHEN sessions.source_to IS NULL THEN excluded.source_to ELSE MAX(sessions.source_to,COALESCE(excluded.source_to,sessions.source_to)) END,
        version=COALESCE(excluded.version,sessions.version),events=sessions.events+excluded.events,failures=sessions.failures+excluded.failures,
        failure_kinds=(SELECT json_group_array(kind) FROM (SELECT value AS kind FROM json_each(sessions.failure_kinds) UNION SELECT value AS kind FROM json_each(excluded.failure_kinds) ORDER BY kind LIMIT 16)),
        source_time_unknown=sessions.source_time_unknown+excluded.source_time_unknown,
        batches=sessions.batches+1,bytes=sessions.bytes+excluded.bytes,expires_at=MAX(sessions.expires_at,excluded.expires_at)`,
        installation,
        storedIndex.sessionId ?? 'legacy-unknown',
        row.received_at,
        row.received_at,
        storedIndex.from,
        storedIndex.to,
        storedIndex.version,
        storedIndex.events,
        storedIndex.failures,
        JSON.stringify(storedIndex.failureKinds),
        storedIndex.sourceTimeUnknownRecords,
        row.bytes,
        row.received_at + LIMITS.indexDays * DAY,
        installation,
        id,
        owner,
        installation,
      ),
      sql(
        env,
        `UPDATE batches SET state='ready' WHERE installation_id=? AND id=? AND owner=? AND state='pending'
        AND EXISTS(SELECT 1 FROM installations WHERE id=? AND revoked_at IS NULL)`,
        installation,
        id,
        owner,
        installation,
      ),
      batchStatement(env, installation, id),
    ]);
    const committed = finalized[2]?.results[0] as BatchRow | undefined;
    if (committed && committed.owner !== owner)
      return json({ error: 'concurrent_owner_pending' }, 409);
    if (committed?.state !== 'ready') {
      await env.DIAGNOSTICS_BUCKET.delete(row.object_key);
      await sql(
        env,
        "UPDATE batches SET state='failed' WHERE installation_id=? AND id=? AND owner=?",
        installation,
        id,
        owner,
      ).run();
      return json({ error: 'installation_revoked' }, 410);
    }
    return accepted(id);
  } catch (error) {
    // The owner has stopped issuing writes. Keep a retryable locator and original TTL.
    await sql(
      env,
      "UPDATE batches SET state='failed' WHERE installation_id=? AND id=? AND owner=? AND state='pending'",
      installation,
      id,
      owner,
    ).run();
    throw error;
  } finally {
    // Every owner stops issuing object writes before closing its durable count.
    // A crashed owner remains explicitly uncertain; a retry can restore delivery
    // without pretending the earlier writer ceased to exist.
    const closed = await env.DIAGNOSTICS_DB.batch<unknown>([
      sql(
        env,
        'UPDATE batches SET writers=writers-1 WHERE installation_id=? AND id=? AND writers>0',
        installation,
        id,
      ),
      sql(env, 'SELECT revoked_at FROM installations WHERE id=?', installation),
    ]);
    const identity = closed[1]?.results[0] as { revoked_at: number | null } | undefined;
    if (!identity || identity.revoked_at !== null) {
      const stored = row ?? (await batchRow(env, installation, id));
      if (stored) await env.DIAGNOSTICS_BUCKET.delete(stored.object_key);
      await sql(
        env,
        'DELETE FROM batches WHERE installation_id=? AND id=? AND writers=0',
        installation,
        id,
      ).run();
    }
  }
}
async function withdraw(env: Env, installation: string) {
  await sql(
    env,
    'UPDATE installations SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',
    Date.now(),
    installation,
  ).run();
  await sql(env, 'DELETE FROM sessions WHERE installation_id=?', installation).run();
  const { results } = await sql(
    env,
    'SELECT * FROM batches WHERE installation_id=? LIMIT 99',
    installation,
  ).all<BatchRow>();
  if (results.length) await env.DIAGNOSTICS_BUCKET.delete(results.map((row) => row.object_key));
  // A pending/uncertain writer closes its own reservation after its put settles.
  // Revocation fences new reservations; this never guesses a crashed writer finished.
  const finished = results.filter((row) => row.writers === 0);
  if (finished.length)
    await sql(
      env,
      `DELETE FROM batches WHERE installation_id=? AND writers=0 AND id IN (${finished.map(() => '?').join(',')})`,
      installation,
      ...finished.map((row) => row.id),
    ).run();
  const remaining = await sql(
    env,
    'SELECT COUNT(*) AS count FROM batches WHERE installation_id=?',
    installation,
  ).first<{ count: number }>();
  return json(
    {
      installationId: installation,
      revoked: true,
      deletion: remaining?.count ? 'pending' : 'complete',
    },
    remaining?.count ? 202 : 200,
  );
}
/** Bounded pages, bulk R2/D1 deletion, and a deleting claim prevent retry/cleanup races.
 * Non-pending expired bodies progress even when a crashed writer remains unresolved. */
export async function cleanup(env: Env, now = Date.now()) {
  const expired = await sql(
    env,
    `SELECT * FROM batches WHERE writers=0 AND expires_at<=? ORDER BY expires_at LIMIT ?`,
    now,
    LIMITS.cleanupObjects,
  ).all<BatchRow>();
  const revoked = await sql(
    env,
    `SELECT b.* FROM installations i JOIN batches b ON b.installation_id=i.id
    WHERE i.revoked_at IS NOT NULL AND b.writers=0 LIMIT ?`,
    LIMITS.cleanupObjects,
  ).all<BatchRow>();
  const unresolved = await sql(
    env,
    `SELECT b.* FROM batches b JOIN installations i ON i.id=b.installation_id
    WHERE b.writers>0 AND (b.expires_at<=? OR i.revoked_at IS NOT NULL) ORDER BY b.cleanup_after LIMIT 10`,
    now,
  ).all<BatchRow>();
  const finished = [
    ...new Map(
      [...expired.results, ...revoked.results].map((row) => [
        `${row.installation_id}:${row.id}`,
        row,
      ]),
    ).values(),
  ].slice(0, LIMITS.cleanupObjects);
  const results = [...finished, ...unresolved.results];
  // At most 48 composite keys per statement: 96 bindings plus claim/clock,
  // below D1's 100-bound-parameter limit. rowid is never a cross-await identity.
  for (let offset = 0; offset < finished.length; offset += 48) {
    const candidates = finished.slice(offset, offset + 48);
    const keys = candidates.flatMap((row) => [row.installation_id, row.id]);
    const placeholders = candidates.map(() => '(?,?)').join(',');
    const claim = crypto.randomUUID();
    const claimed = await env.DIAGNOSTICS_DB.batch([
      sql(
        env,
        `UPDATE batches SET state='deleting',owner=? WHERE writers=0
        AND (expires_at<=? OR EXISTS(SELECT 1 FROM installations WHERE id=batches.installation_id AND revoked_at IS NOT NULL))
        AND (installation_id,id) IN (${placeholders})`,
        claim,
        now,
        ...keys,
      ),
      sql(
        env,
        `SELECT installation_id,id,object_key FROM batches WHERE state='deleting' AND owner=?
        AND (installation_id,id) IN (${placeholders})`,
        claim,
        ...keys,
      ),
    ]);
    const rows = claimed[1]!.results as {
      installation_id: string;
      id: string;
      object_key: string;
    }[];
    if (rows.length) {
      await env.DIAGNOSTICS_BUCKET.delete(rows.map((row) => row.object_key));
      await sql(
        env,
        `DELETE FROM batches WHERE state='deleting' AND owner=?
        AND (installation_id,id) IN (${rows.map(() => '(?,?)').join(',')})`,
        claim,
        ...rows.flatMap((row) => [row.installation_id, row.id]),
      ).run();
    }
  }
  if (unresolved.results.length) {
    const keys = unresolved.results.flatMap((row) => [row.installation_id, row.id, row.owner]);
    const placeholders = unresolved.results.map(() => '(?,?,?)').join(',');
    const stillUncertain = await sql(
      env,
      `SELECT * FROM batches WHERE writers>0
      AND (expires_at<=? OR EXISTS(SELECT 1 FROM installations WHERE id=batches.installation_id AND revoked_at IS NOT NULL))
      AND (installation_id,id,owner) IN (${placeholders})`,
      now,
      ...keys,
    ).all<BatchRow>();
    if (stillUncertain.results.length) {
      await env.DIAGNOSTICS_BUCKET.delete(stillUncertain.results.map((row) => row.object_key));
      await sql(
        env,
        `UPDATE batches SET cleanup_after=?,metadata=CASE WHEN expires_at<=? THEN '{}' ELSE metadata END
        WHERE writers>0 AND (expires_at<=? OR EXISTS(SELECT 1 FROM installations WHERE id=batches.installation_id AND revoked_at IS NOT NULL))
        AND (installation_id,id,owner) IN (${stillUncertain.results.map(() => '(?,?,?)').join(',')})`,
        now,
        now,
        now,
        ...stillUncertain.results.flatMap((row) => [row.installation_id, row.id, row.owner]),
      ).run();
    }
  }
  await sql(
    env,
    'DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at<=? LIMIT 100)',
    now,
  ).run();
  await sql(
    env,
    `DELETE FROM sessions WHERE rowid IN (
    SELECT s.rowid FROM installations AS i INDEXED BY installations_revoked
    CROSS JOIN sessions AS s ON s.installation_id=i.id
    WHERE i.revoked_at IS NOT NULL LIMIT 100)`,
  ).run();
  await sql(env, 'DELETE FROM daily WHERE day<?', Math.floor(now / DAY) - 2).run();
  // The fixed timestamp in UUIDv7 closes old enrollment proofs after 90 days.
  // Keep ownership only while its bounded session index/body still needs it;
  // a genuinely unresolved writer remains quarantined, never falsely complete.
  await sql(
    env,
    `DELETE FROM installations WHERE rowid IN (SELECT rowid FROM installations WHERE lease_expires_at<=?
    AND NOT EXISTS(SELECT 1 FROM batches WHERE installation_id=installations.id)
    AND NOT EXISTS(SELECT 1 FROM sessions WHERE installation_id=installations.id) LIMIT 100)`,
    now,
  ).run();
  await sql(
    env,
    `DELETE FROM upload_permits WHERE payload_sha256 IN (
    SELECT payload_sha256 FROM upload_permits WHERE retire_at<=? ORDER BY retire_at LIMIT 100)`,
    now,
  ).run();
  return { visited: results.length, unresolvedWriters: unresolved.results.length };
}
async function admin(request: Request, env: Env, path: string, now: number) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!equal(authorization, `Bearer ${env.ADMIN_KEY}`)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  if (path === '/admin/health' && request.method === 'GET') {
    const day = Math.floor(now / DAY);
    const daily = await sql(
      env,
      'SELECT day,bytes,batches,permits,registrations FROM daily WHERE day=?',
      day,
    ).first();
    const storage = await sql(
      env,
      'SELECT COUNT(*) AS reservations,SUM(writers) AS writers FROM batches WHERE writers>0',
    ).all();
    return json({
      accepting: env.ACCEPTING === '1',
      dailyReservations: daily,
      openWriters: storage.results[0],
      d1AllocatedBytes: storage.meta.size_after,
      limits: {
        dailyBytes: budget(env.DAILY_BYTES),
        dailyBatches: budget(env.DAILY_BATCHES),
        dailyRegistrations: budget(env.DAILY_REGISTRATIONS),
        installationDailyBytes: budget(env.INSTALLATION_DAILY_BYTES),
        installationDailyBatches: budget(env.INSTALLATION_DAILY_BATCHES),
        databaseBytes: budget(env.DATABASE_BYTES),
      },
      scope:
        'application reservations and this database allocation; excludes other account usage and does not guarantee zero account charges',
    });
  }
  if (path === '/admin/sessions' && request.method === 'GET') {
    const installation = url.searchParams.get('installation');
    const session = url.searchParams.get('session');
    const version = url.searchParams.get('version');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const failures = url.searchParams.get('onlyFailures');
    const validTime = (value: string | null) =>
      value === null ||
      (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)));
    if (
      (installation && !uuid.test(installation)) ||
      (session && !uuid.test(session)) ||
      (version && !/^[a-zA-Z0-9.+_-]{1,64}$/.test(version)) ||
      !validTime(from) ||
      !validTime(to) ||
      (failures !== null && failures !== '1') ||
      (from && to && from > to)
    )
      return json({ error: 'invalid_filter' }, 400);
    const filters = [
      'expires_at>?',
      'EXISTS(SELECT 1 FROM installations WHERE id=sessions.installation_id AND revoked_at IS NULL)',
    ];
    const values: (string | number)[] = [now];
    for (const [column, value] of [
      ['installation_id', installation],
      ['session_id', session],
      ['version', version],
    ] as const)
      if (value) {
        filters.push(`${column}=?`);
        values.push(value);
      }
    if (from) {
      filters.push('source_to>=?');
      values.push(from);
    }
    if (to) {
      filters.push('source_from<=?');
      values.push(to);
    }
    if (failures) filters.push('failures>0');
    const cursorText = url.searchParams.get('cursor');
    if (cursorText) {
      let cursor: unknown;
      try {
        cursor = cursorText.length <= 256 ? JSON.parse(cursorText) : null;
      } catch {
        return json({ error: 'invalid_cursor' }, 400);
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 3 ||
        !Number.isSafeInteger(cursor[0]) ||
        typeof cursor[1] !== 'string' ||
        !uuid.test(cursor[1]) ||
        typeof cursor[2] !== 'string' ||
        (!uuid.test(cursor[2]) && cursor[2] !== 'legacy-unknown')
      )
        return json({ error: 'invalid_cursor' }, 400);
      filters.push('(expires_at,installation_id,session_id)<(?,?,?)');
      values.push(cursor[0] as number, cursor[1], cursor[2]);
    }
    const result = await sql(
      env,
      `SELECT * FROM sessions WHERE ${filters.join(' AND ')} ORDER BY expires_at DESC,installation_id DESC,session_id DESC LIMIT 100`,
      ...values,
    ).all<{ expires_at: number; installation_id: string; session_id: string }>();
    const last = result.results.at(-1);
    return json({
      sessions: result.results,
      nextCursor:
        result.results.length === 100 && last
          ? JSON.stringify([last.expires_at, last.installation_id, last.session_id])
          : null,
      timeFilterBasis: 'source UTC overlap; unknown source times do not match a time filter',
    });
  }
  if (path === '/admin/batches' && request.method === 'GET') {
    const installation = url.searchParams.get('installation');
    if (!installation || !uuid.test(installation))
      return json({ error: 'invalid_installation' }, 400);
    const filters = [
      'installation_id=?',
      'expires_at>?',
      'EXISTS(SELECT 1 FROM installations WHERE id=batches.installation_id AND revoked_at IS NULL)',
    ];
    const values: (string | number)[] = [installation, now];
    const cursorText = url.searchParams.get('cursor');
    if (cursorText) {
      let cursor: unknown;
      try {
        cursor = cursorText.length <= 192 ? JSON.parse(cursorText) : null;
      } catch {
        return json({ error: 'invalid_cursor' }, 400);
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        !Number.isSafeInteger(cursor[0]) ||
        typeof cursor[1] !== 'string' ||
        !digest.test(cursor[1])
      )
        return json({ error: 'invalid_cursor' }, 400);
      filters.push('(received_at,id)<(?,?)');
      values.push(cursor[0] as number, cursor[1]);
    }
    const result = await sql(
      env,
      `SELECT id,received_at,expires_at,bytes,state,writers,metadata FROM batches WHERE ${filters.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT 100`,
      ...values,
    ).all<{ received_at: number; id: string }>();
    const last = result.results.at(-1);
    return json({
      batches: result.results,
      nextCursor:
        result.results.length === 100 && last ? JSON.stringify([last.received_at, last.id]) : null,
    });
  }
  const match = /^\/admin\/bodies\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(path);
  if (match && uuid.test(match[1]!) && request.method === 'GET') {
    const row = await batchRow(env, match[1]!, match[2]!);
    const installation = await sql(
      env,
      'SELECT revoked_at FROM installations WHERE id=?',
      match[1]!,
    ).first<{ revoked_at: number | null }>();
    if (
      !row ||
      row.state !== 'ready' ||
      row.expires_at <= now ||
      !installation ||
      installation.revoked_at !== null
    )
      return json({ error: 'body_unavailable' }, 404);
    const object = await env.DIAGNOSTICS_BUCKET.get(row.object_key);
    if (!object || object.size > LIMITS.compressedBytes)
      return json({ error: 'body_unavailable' }, 404);
    return new Response(object.body, {
      headers: {
        'content-type': 'application/gzip',
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="diagnostics.gz"',
      },
    });
  }
  if (path === '/admin/cleanup' && request.method === 'POST') return json(await cleanup(env, now));
  return json({ error: 'not_found' }, 404);
}
export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (
    ![env.INGEST_SIGNING_KEY, env.IP_HASH_KEY, env.ADMIN_KEY].every(
      (value) => typeof value === 'string' && value.length >= 32,
    )
  )
    return json({ error: 'not_configured' }, 503);
  const path = new URL(request.url).pathname;
  if (request.headers.has('origin')) return json({ error: 'browser_ingestion_forbidden' }, 403);
  if (path.startsWith('/admin/')) {
    try {
      return await admin(request, env, path, now);
    } catch {
      return json({ error: 'maintenance_storage_unconfirmed' }, 503);
    }
  }
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return json({ error: 'missing_edge_identity' }, 403);
  const ipKey = base64(await mac(env.IP_HASH_KEY, `${Math.floor(now / DAY)}:${ip}`));
  const limiter = path === '/v1/diagnostics/enroll' ? env.ENROLL_LIMITER : env.UPLOAD_LIMITER;
  if (!(await limiter.limit({ key: ipKey })).success) return json({ error: 'rate_limited' }, 429);
  try {
    if (path === '/v1/diagnostics/enroll' && request.method === 'POST')
      return await enroll(request, env, now);
    const deleting = path === '/v1/diagnostics/installation' && request.method === 'DELETE';
    const installation = await authenticate(request, env, now, deleting);
    if (!installation) return json({ error: 'unauthorized' }, 401);
    if (deleting) return await withdraw(env, installation);
    const permitMatch = /^\/v1\/diagnostics\/permits\/([a-f0-9]{64})$/.exec(path);
    if (permitMatch && request.method === 'POST') {
      if (env.ACCEPTING !== '1') return json({ error: 'intake_paused' }, 503);
      const owner = await sql(
        env,
        'SELECT created_at FROM installations WHERE id=? AND revoked_at IS NULL',
        installation,
      ).first<{ created_at: number }>();
      if (!owner) return json({ error: 'unauthorized' }, 401);
      const payloadCreatedAt = Number(request.headers.get('x-diagnostics-created-at'));
      const clockReason = diagnosticAutomaticTimeReason(payloadCreatedAt, now);
      if (clockReason) return json({ error: clockReason }, 410);
      const payload = permitMatch[1]!;
      let first = await permitRow(env, payload);
      if (!first) {
        if (!budget(env.DAILY_BATCHES) || !budget(env.INSTALLATION_DAILY_BATCHES))
          return json({ error: 'permit_budget' }, 429);
        if (!(await withinDatabaseBudget(env)))
          return json({ error: 'index_allocation_budget' }, 503);
        const day = Math.floor(now / DAY);
        await sql(env, 'INSERT OR IGNORE INTO daily(day) VALUES(?)', day).run();
        // D1 batch is transactional. changes() carries each successful insert
        // through the two counters; replayed/competing insertions charge neither.
        const reservation = await env.DIAGNOSTICS_DB.batch([
          sql(
            env,
            `INSERT OR IGNORE INTO upload_permits(payload_sha256,installation_id,installation_created_at,consent_revision,issued_at,payload_created_at,retire_at)
            SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM installations WHERE id=? AND created_at=? AND revoked_at IS NULL
              AND (quota_day!=? OR quota_permits<?)) AND EXISTS(SELECT 1 FROM daily WHERE day=? AND permits<?)`,
            binaryId(payload),
            binaryId(installation),
            owner.created_at,
            DIAGNOSTIC_CONSENT_REVISION,
            now,
            payloadCreatedAt,
            payloadCreatedAt + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS,
            installation,
            owner.created_at,
            day,
            budget(env.INSTALLATION_DAILY_BATCHES),
            day,
            budget(env.DAILY_BATCHES),
          ),
          sql(env, 'UPDATE daily SET permits=permits+1 WHERE day=? AND changes()>0', day),
          sql(
            env,
            `UPDATE installations SET quota_bytes=CASE WHEN quota_day=? THEN quota_bytes ELSE 0 END,
            quota_batches=CASE WHEN quota_day=? THEN quota_batches ELSE 0 END,
            quota_permits=CASE WHEN quota_day=? THEN quota_permits+1 ELSE 1 END,quota_day=? WHERE id=? AND changes()>0`,
            day,
            day,
            day,
            day,
            installation,
          ),
        ]);
        if (!reservation[0]?.meta.changes && !(await permitRow(env, payload)))
          return json({ error: 'permit_budget' }, 429);
        first = await permitRow(env, payload);
      }
      if (
        !first ||
        first.installation_hex !== installation.replaceAll('-', '') ||
        first.installation_created_at !== owner.created_at ||
        first.consent_revision !== DIAGNOSTIC_CONSENT_REVISION ||
        first.payload_created_at !== payloadCreatedAt
      )
        return json({ error: 'payload_identity_conflict' }, 409);
      if (Math.min(first.issued_at + DIAGNOSTIC_BODY_LIFETIME_MS, first.retire_at) <= now)
        return json({ error: 'batch_retention_expired' }, 410);
      const claims: Omit<DiagnosticUploadPermit, 'signature'> = {
        schema: 'mizar-diagnostic-permit/2',
        installationId: installation,
        installationCreatedAt: first.installation_created_at,
        consentRevision: DIAGNOSTIC_CONSENT_REVISION,
        payloadSha256: payload,
        payloadCreatedAt: first.payload_created_at,
        issuedAt: first.issued_at,
        expiresAt: Math.min(first.issued_at + DIAGNOSTIC_BODY_LIFETIME_MS, first.retire_at),
      };
      return json({
        ...claims,
        signature: base64(await mac(env.INGEST_SIGNING_KEY, diagnosticPermitClaims(claims))),
      });
    }
    const match = /^\/v1\/diagnostics\/batches\/([a-f0-9]{64})$/.exec(path);
    if (match && request.method === 'PUT')
      return await upload(request, env, match[1]!, installation, now);
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
    if (
      error instanceof Error &&
      ['body_too_large', 'missing_body', 'body_timeout'].includes(error.message)
    )
      return json({ error: error.message }, error.message === 'body_too_large' ? 413 : 400);
    // Never log request bodies, authorization, paths, or raw SQL/remote exceptions.
    return json({ error: 'storage_unconfirmed' }, 503);
  }
}
export default {
  fetch(request: Request, env: Env) {
    return handle(request, env);
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
