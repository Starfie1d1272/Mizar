import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, safePath } from '../resource-store/files.js';

const UUID = /^[a-f0-9-]{36}$/;
const immutableName =
  /^(?:(?:session|desktop|document)-[a-f0-9-]{36}\.ndjson|performance-pending\/[a-f0-9-]{36}\.[a-f0-9]{4}\.gz)$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const META_LIMIT = 4 * 1024 * 1024;
export interface SegmentMetadata {
  producerRunId: string;
  firstSequence: number | null;
  lastSequence: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  records: number;
}
export interface RetainedSegment extends SegmentMetadata {
  name: string;
  physicalId: string;
  bytes: number;
  sha256: string;
  sealedAt: string;
}
export interface PinReceipt {
  readonly sourceState?: unknown;
  pinId: string;
  producerId: string;
  status: 'prepared' | 'committed';
  kind: 'incident' | 'export' | 'delivery' | 'active';
  expiresAt: number | null;
  segments: RetainedSegment[];
  confirmedAt: string;
}
export interface ProducerInventory {
  schema: 'mizar-retention/2';
  producerId: string;
  segments: RetainedSegment[];
  pins: PinReceipt[];
  deleting: string[];
  removedSegments?: (RetainedSegment & { removedAt: string; reason: 'retention' })[];
  removed: { files: number; bytes: number; lastAt: string | null; olderRangeRecords?: number };
}
async function boundedJson<T>(root: string, name: string, maximum = META_LIMIT): Promise<T> {
  const path = await safePath(root, name);
  const before = await lstat(path);
  if (before.size > maximum) throw new Error('retention_metadata_budget');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.nlink !== 1 ||
      stat.size !== before.size
    )
      throw new Error('retention_metadata_changed');
    return JSON.parse(await file.readFile('utf8')) as T;
  } finally {
    await file.close();
  }
}
async function describe(
  root: string,
  name: string,
): Promise<Pick<RetainedSegment, 'physicalId' | 'bytes' | 'sha256'>> {
  if (!immutableName.test(name)) throw new Error('retention_source_not_immutable');
  const path = await safePath(root, name);
  const before = await lstat(path);
  if (before.size > 2 * 1024 * 1024) throw new Error('retention_segment_budget');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await file.stat();
    if (
      initial.dev !== before.dev ||
      initial.ino !== before.ino ||
      initial.size !== before.size ||
      initial.nlink !== 1
    )
      throw new Error('retention_source_changed');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < initial.size) {
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, initial.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error('retention_source_truncated');
      digest.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(await safePath(root, name));
    if (
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      named.ino !== initial.ino ||
      named.dev !== initial.dev
    )
      throw new Error('retention_source_changed');
    const sha256 = digest.digest('hex');
    return { physicalId: `${initial.dev}:${initial.ino}:${sha256}`, bytes: initial.size, sha256 };
  } finally {
    await file.close();
  }
}

/** Call from the producer's existing write/rotation queue. This is not a second writer.
 * Only sealed immutable files registered by that producer are eligible for collection. */
export class ProducerRetention {
  private state: ProducerInventory;
  private ready = false;
  private readonly deliveryHolds = new Set<string>();
  private readonly name: string;
  constructor(
    private readonly root: string,
    readonly producerId: string,
    private readonly limits: { budgetBytes: number; retentionMs: number },
  ) {
    if (!/^[a-z][a-z0-9_-]{0,48}$/.test(producerId)) throw new Error('retention_producer_invalid');
    this.name = `retention-${producerId}.json`;
    this.state = {
      schema: 'mizar-retention/2',
      producerId,
      segments: [],
      pins: [],
      deleting: [],
      removed: { files: 0, bytes: 0, lastAt: null },
    };
  }
  private async save() {
    if (Buffer.byteLength(JSON.stringify(this.state)) > META_LIMIT)
      throw new Error('retention_metadata_budget');
    await atomicJson(join(this.root, this.name), this.state);
  }
  async initialize(now = Date.now()) {
    if (this.ready) return;
    await mkdir(this.root, { recursive: true });
    await safePath(this.root);
    try {
      const stored = await boundedJson<ProducerInventory>(this.root, this.name);
      if (
        stored.schema !== this.state.schema ||
        stored.producerId !== this.producerId ||
        !Array.isArray(stored.segments) ||
        !Array.isArray(stored.pins) ||
        !Array.isArray(stored.deleting) ||
        stored.segments.some(
          (value) =>
            !immutableName.test(value.name) ||
            !Number.isSafeInteger(value.bytes) ||
            value.bytes < 0 ||
            !/^[a-f0-9]{64}$/.test(value.sha256),
        ) ||
        stored.pins.some(
          (value) =>
            !UUID.test(value.pinId) ||
            value.producerId !== this.producerId ||
            !Array.isArray(value.segments),
        )
      )
        throw new Error('retention_inventory_invalid');
      this.state = stored;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    // Export and delivery leases cannot survive their owning process. Prepared
    // incident reservations remain recoverable until their explicit deadline;
    // committed incident pins never expire.
    this.state.pins = this.state.pins.filter(
      (pin) =>
        !['export', 'delivery'].includes(pin.kind) &&
        (pin.expiresAt === null || pin.expiresAt > now),
    );
    await this.finishDeletes();
    await this.save();
    this.ready = true;
  }
  async registerSegment(name: string, metadata: SegmentMetadata): Promise<RetainedSegment> {
    await this.initialize();
    const actual = await describe(this.root, name);
    const prior = this.state.segments.find((value) => value.name === name);
    if (prior) {
      if (prior.physicalId !== actual.physicalId || prior.bytes !== actual.bytes)
        throw new Error('immutable_segment_replaced');
      return structuredClone(prior);
    }
    const segment = { ...metadata, ...actual, name, sealedAt: new Date().toISOString() };
    this.state.segments.push(segment);
    try {
      await this.save();
    } catch (error) {
      this.state.segments.pop();
      throw error;
    }
    return structuredClone(segment);
  }
  /** Extend the active run with the segment just registered in this same producer queue.
   * Immutable bytes were verified by registerSegment; export/incident boundaries recheck them. */
  async protectActiveSegment(pinId: string, name: string): Promise<void> {
    await this.initialize();
    if (!UUID.test(pinId)) throw new Error('retention_pin_invalid');
    const segment = this.state.segments.find((value) => value.name === name);
    if (!segment || segment.producerRunId !== pinId || this.state.deleting.includes(name))
      throw new Error('retention_source_unregistered');
    const previous = structuredClone(this.state.pins);
    let pin = this.state.pins.find((value) => value.pinId === pinId);
    if (pin && pin.kind !== 'active') throw new Error('retention_pin_identity_conflict');
    if (!pin) {
      pin = {
        pinId,
        producerId: this.producerId,
        kind: 'active',
        status: 'committed',
        expiresAt: null,
        segments: [],
        confirmedAt: new Date().toISOString(),
      };
      this.state.pins.push(pin);
    }
    if (!pin.segments.some((value) => value.name === name)) pin.segments.push(segment);
    try {
      await this.save();
    } catch (error) {
      this.state.pins = previous;
      throw error;
    }
  }
  async preparePin(request: {
    pinId: string;
    kind: PinReceipt['kind'];
    names: string[];
    expiresAt?: number;
  }): Promise<PinReceipt> {
    await this.initialize();
    if (!UUID.test(request.pinId) || request.names.length > 4096)
      throw new Error('retention_pin_invalid');
    const prior = this.state.pins.find((pin) => pin.pinId === request.pinId);
    if (prior) {
      if (
        prior.kind !== request.kind ||
        prior.segments
          .map((value) => value.name)
          .sort()
          .join('\n') !== [...new Set(request.names)].sort().join('\n')
      )
        throw new Error('retention_pin_identity_conflict');
      return structuredClone(prior);
    }
    const segments: RetainedSegment[] = [];
    for (const name of new Set(request.names)) {
      const segment = this.state.segments.find((value) => value.name === name);
      if (!segment || this.state.deleting.includes(name))
        throw new Error('retention_source_unregistered');
      const actual = await describe(this.root, name);
      if (actual.physicalId !== segment.physicalId) throw new Error('retention_source_changed');
      segments.push(segment);
    }
    const receipt: PinReceipt = {
      pinId: request.pinId,
      producerId: this.producerId,
      kind: request.kind,
      status: 'prepared',
      expiresAt: request.expiresAt ?? Date.now() + 15 * 60_000,
      segments,
      confirmedAt: new Date().toISOString(),
    };
    this.state.pins.push(receipt);
    try {
      await this.save();
    } catch (error) {
      this.state.pins.pop();
      throw error;
    }
    return structuredClone(receipt);
  }
  async commitPin(pinId: string): Promise<PinReceipt> {
    await this.initialize();
    const receipt = this.state.pins.find((pin) => pin.pinId === pinId);
    if (!receipt || (receipt.expiresAt !== null && receipt.expiresAt <= Date.now()))
      throw new Error('retention_pin_expired');
    if (receipt.kind === 'incident') {
      const coordinator = await boundedJson<{ schema: string; marks: IncidentReservation[] }>(
        this.root,
        'incident-pins.json',
      );
      const reservation = coordinator.marks.find(
        (mark) =>
          mark.pinId === pinId && ['reserved', 'partial', 'committed'].includes(mark.status),
      );
      const reserved = reservation?.receipts.find((value) => value.producerId === this.producerId);
      if (
        coordinator.schema !== 'mizar-incident-pins/2' ||
        !reserved ||
        JSON.stringify(reserved.segments) !== JSON.stringify(receipt.segments)
      )
        throw new Error('incident_budget_reservation_missing');
    }
    const previous = structuredClone(receipt);
    receipt.status = 'committed';
    if (!['export', 'delivery'].includes(receipt.kind)) receipt.expiresAt = null;
    receipt.confirmedAt = new Date().toISOString();
    try {
      await this.save();
    } catch (error) {
      Object.assign(receipt, previous);
      throw error;
    }
    // A running ACK transaction owns this hold through unlink, even after its
    // admission deadline. A restarted producer discards delivery leases.
    if (receipt.kind === 'delivery') this.deliveryHolds.add(pinId);
    return structuredClone(receipt);
  }
  async releasePin(pinId: string): Promise<void> {
    await this.initialize();
    const previous = this.state.pins;
    this.state.pins = previous.filter((pin) => pin.pinId !== pinId);
    try {
      await this.save();
    } catch (error) {
      this.state.pins = previous;
      throw error;
    }
    this.deliveryHolds.delete(pinId);
  }
  private async finishDeletes() {
    for (const name of [...this.state.deleting]) {
      const segment = this.state.segments.find((value) => value.name === name);
      if (
        !segment ||
        this.state.pins.some((pin) => pin.segments.some((value) => value.name === name))
      )
        throw new Error('retention_delete_conflict');
      try {
        const actual = await describe(this.root, name);
        if (actual.physicalId !== segment.physicalId)
          throw new Error('retention_delete_identity_changed');
        await unlink(await safePath(this.root, name));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      this.state.segments = this.state.segments.filter((value) => value.name !== name);
      this.state.deleting = this.state.deleting.filter((value) => value !== name);
      this.state.removed.files++;
      this.state.removed.bytes += segment.bytes;
      this.state.removed.lastAt = new Date().toISOString();
      this.state.removedSegments ??= [];
      this.state.removedSegments.push({
        ...segment,
        removedAt: this.state.removed.lastAt,
        reason: 'retention',
      });
      if (this.state.removedSegments.length > 4096) {
        this.state.removedSegments.shift();
        this.state.removed.olderRangeRecords = (this.state.removed.olderRangeRecords ?? 0) + 1;
      }
      await this.save();
    }
  }
  incidentSegmentNames(): ReadonlySet<string> {
    const now = Date.now();
    return new Set(
      this.state.pins
        .filter(
          (pin) =>
            pin.kind === 'incident' &&
            pin.status === 'committed' &&
            (pin.expiresAt === null || pin.expiresAt > now),
        )
        .flatMap((pin) =>
          pin.segments
            .filter((segment) =>
              this.state.segments.some(
                (registered) =>
                  registered.name === segment.name &&
                  registered.physicalId === segment.physicalId &&
                  registered.bytes === segment.bytes &&
                  registered.sha256 === segment.sha256,
              ),
            )
            .map((segment) => segment.name),
        ),
    );
  }
  async collect(options: {
    incomingBytes: number;
    capacity?: readonly {
      limit: number;
      incoming: number;
      cost: (segment: RetainedSegment) => number;
    }[];
    now?: number;
    beforeDelete?: (segments: readonly RetainedSegment[]) => Promise<void>;
  }) {
    const now = options.now ?? Date.now();
    await this.initialize(now);
    this.state.pins = this.state.pins.filter(
      (pin) => this.deliveryHolds.has(pin.pinId) || pin.expiresAt === null || pin.expiresAt > now,
    );
    const pinned = new Set(
      this.state.pins.flatMap((pin) => pin.segments.map((value) => value.name)),
    );
    // Only committed incident pins are charged to the separate shared incident budget.
    const extra = this.incidentSegmentNames();
    const ordinary = this.state.segments.filter((value) => !extra.has(value.name));
    let ordinaryBytes = ordinary.reduce((n, value) => n + value.bytes, 0);
    const capacity = (options.capacity ?? []).map((dimension) => ({
      ...dimension,
      used: ordinary.reduce((total, segment) => total + dimension.cost(segment), 0),
    }));
    const writable = () =>
      ordinaryBytes + options.incomingBytes <= this.limits.budgetBytes &&
      capacity.every((dimension) => dimension.used + dimension.incoming <= dimension.limit);
    for (const segment of [...this.state.segments].sort((a, b) =>
      a.sealedAt.localeCompare(b.sealedAt),
    )) {
      if (pinned.has(segment.name)) continue;
      if (writable() && now - Date.parse(segment.sealedAt) <= this.limits.retentionMs) continue;
      this.state.deleting.push(segment.name);
      ordinaryBytes -= segment.bytes;
      for (const dimension of capacity) dimension.used -= dimension.cost(segment);
    }
    if (options.beforeDelete && this.state.deleting.length) {
      try {
        await options.beforeDelete(
          this.state.segments.filter((segment) => this.state.deleting.includes(segment.name)),
        );
      } catch (error) {
        this.state.deleting = [];
        throw error;
      }
    }
    // Commit deletion intent before unlink. Restart resumes the same identity-checked operation.
    await this.save();
    await this.finishDeletes();
    return {
      ...this.snapshot(),
      writable: writable(),
    };
  }
  snapshot() {
    return structuredClone(this.state);
  }
}

export interface IncidentParticipant {
  producerId: string;
  externalCommit?: boolean;
  /** Seal and prepare under the actual producer's write/rotation serial section. */
  prepare(pinId: string): Promise<PinReceipt>;
  commit(pinId: string): Promise<PinReceipt>;
  release(pinId: string): Promise<void>;
}
export interface IncidentReservation {
  pinId: string;
  marker: { category: string; observedAt: string; eventId: string };
  status: 'preparing' | 'reserved' | 'committed' | 'partial';
  receipts: PinReceipt[];
  unavailable: string[];
  failures?: { producerId: string; phase: string; at: string; cause: unknown }[];
}
/** One shared eight-mark/64MiB budget. Producers retain sole authority over their files. */
export class IncidentPinCoordinator {
  private serial: Promise<unknown> = Promise.resolve();
  private state: { schema: 'mizar-incident-pins/2'; marks: IncidentReservation[] } = {
    schema: 'mizar-incident-pins/2',
    marks: [],
  };
  private ready = false;
  constructor(private readonly root: string) {}
  private async save() {
    await atomicJson(join(this.root, 'incident-pins.json'), this.state);
  }
  private async initialize() {
    if (this.ready) return;
    try {
      const value = await boundedJson<typeof this.state>(this.root, 'incident-pins.json');
      if (
        value.schema !== this.state.schema ||
        !Array.isArray(value.marks) ||
        value.marks.length > 8 ||
        value.marks.some(
          (mark) =>
            !UUID.test(mark.pinId) ||
            !Array.isArray(mark.receipts) ||
            !Array.isArray(mark.unavailable),
        )
      )
        throw new Error('incident_pin_inventory_invalid');
      this.state = value;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    this.ready = true;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(operation);
    this.serial = task.catch(() => undefined);
    return task;
  }
  capture(
    marker: IncidentReservation['marker'],
    participants: IncidentParticipant[],
    requiredProducers: string[],
    existingPinId?: string,
  ) {
    return this.run(async () => {
      await this.initialize();
      if (this.state.marks.length >= 8)
        return {
          recorded: true,
          evidenceRetained: false,
          reason: 'incident_count_budget',
          pinId: null,
        };
      const mark: IncidentReservation = {
        pinId: existingPinId ?? randomUUID(),
        marker,
        status: 'preparing',
        receipts: [],
        unavailable: [],
      };
      if (!UUID.test(mark.pinId) || this.state.marks.some((value) => value.pinId === mark.pinId))
        throw new Error('incident_pin_identity_conflict');
      this.state.marks.push(mark);
      await this.save();
      for (const producerId of requiredProducers) {
        const participant = participants.find((value) => value.producerId === producerId);
        if (!participant) {
          mark.unavailable.push(producerId);
          continue;
        }
        try {
          const receipt = await participant.prepare(mark.pinId);
          if (
            receipt.producerId !== producerId ||
            receipt.pinId !== mark.pinId ||
            receipt.kind !== 'incident'
          )
            throw new Error('incident_receipt_invalid');
          mark.receipts.push(receipt);
          await this.save();
        } catch (error) {
          this.failure(mark, producerId, 'prepare', error);
        }
      }
      const physical = new Map<string, number>();
      for (const item of this.state.marks)
        for (const receipt of item.receipts)
          if (
            receipt.status === 'committed' ||
            receipt.expiresAt === null ||
            receipt.expiresAt > Date.now()
          )
            for (const segment of receipt.segments) physical.set(segment.physicalId, segment.bytes);
      if ([...physical.values()].reduce((n, bytes) => n + bytes, 0) > 64 * 1024 * 1024) {
        for (const participant of participants) {
          try {
            await participant.release(mark.pinId);
          } catch {
            mark.unavailable.push(`${participant.producerId}:release-unconfirmed`);
          }
        }
        mark.receipts = [];
        mark.status = 'partial';
        mark.unavailable.push('incident_shared_budget');
        await this.save();
        return {
          recorded: true,
          evidenceRetained: false,
          reason: 'incident_shared_budget',
          pinId: mark.pinId,
        };
      }
      mark.status = 'reserved';
      await this.save();
      await this.commit(mark, participants);
      return {
        recorded: true,
        evidenceRetained: (mark.status as IncidentReservation['status']) === 'committed',
        requiresHostCommit: mark.receipts.some(
          (receipt) => receipt.producerId === 'host' && receipt.status !== 'committed',
        ),
        reason: mark.status,
        pinId: mark.pinId,
        receipts: structuredClone(mark.receipts),
        unavailable: [...mark.unavailable],
      };
    });
  }
  private failure(mark: IncidentReservation, producerId: string, phase: string, error: unknown) {
    const reason = phase === 'prepare' ? producerId : `${producerId}:${phase}-unconfirmed`;
    if (!mark.unavailable.includes(reason)) mark.unavailable.push(reason);
    const cause = (value: unknown): unknown =>
      value instanceof Error
        ? {
            name: value.name,
            message: value.message,
            ...('code' in value ? { code: value.code } : {}),
            ...(value.cause === undefined ? {} : { cause: cause(value.cause) }),
          }
        : String(value);
    mark.failures ??= [];
    // Bounded attempt history; current blockers are represented separately.
    if (mark.failures.length < 64)
      mark.failures.push({ producerId, phase, at: new Date().toISOString(), cause: cause(error) });
  }
  private async commit(mark: IncidentReservation, participants: IncidentParticipant[]) {
    for (let index = 0; index < mark.receipts.length; index++) {
      const prior = mark.receipts[index]!;
      if (prior.status === 'committed') {
        mark.unavailable = mark.unavailable.filter(
          (reason) =>
            reason !== prior.producerId && reason !== `${prior.producerId}:commit-unconfirmed`,
        );
        continue;
      }
      const participant = participants.find((value) => value.producerId === prior.producerId);
      if (!participant) {
        if (!mark.unavailable.includes(prior.producerId)) mark.unavailable.push(prior.producerId);
        continue;
      }
      try {
        const receipt = await participant.commit(mark.pinId);
        if (participant.externalCommit && receipt.status === 'prepared') continue;
        if (
          receipt.pinId !== mark.pinId ||
          receipt.producerId !== prior.producerId ||
          receipt.status !== 'committed' ||
          JSON.stringify(receipt.segments) !== JSON.stringify(prior.segments)
        )
          throw new Error('incident_commit_receipt_invalid');
        mark.receipts[index] = receipt;
        mark.unavailable = mark.unavailable.filter(
          (reason) =>
            reason !== prior.producerId && reason !== `${prior.producerId}:commit-unconfirmed`,
        );
      } catch (error) {
        this.failure(mark, prior.producerId, 'commit', error);
      }
      await this.save();
    }
    const waitingExternal = mark.receipts.some(
      (receipt) =>
        receipt.status === 'prepared' &&
        participants.some(
          (participant) =>
            participant.producerId === receipt.producerId && participant.externalCommit,
        ),
    );
    mark.status =
      waitingExternal && !mark.unavailable.length
        ? 'reserved'
        : mark.unavailable.length ||
            !mark.receipts.length ||
            mark.receipts.some((value) => value.status !== 'committed')
          ? 'partial'
          : 'committed';
    await this.save();
  }
  confirm(pinId: string, participants: IncidentParticipant[]) {
    return this.run(async () => {
      await this.initialize();
      const mark = this.state.marks.find((value) => value.pinId === pinId);
      if (!mark) throw new Error('incident_reservation_missing');
      if (mark.status !== 'committed') await this.commit(mark, participants);
      return {
        recorded: true,
        pinId,
        evidenceRetained: mark.status === 'committed',
        reason: mark.status,
        requiresHostCommit: mark.receipts.some(
          (receipt) => receipt.producerId === 'host' && receipt.status !== 'committed',
        ),
        receipts: structuredClone(mark.receipts),
        unavailable: [...mark.unavailable],
      };
    });
  }
  /** Resume only persisted reservations; never invent a Host acknowledgment after restart. */
  recover(
    participants: IncidentParticipant[],
    external: (pinId: string) => IncidentParticipant[] = () => [],
  ) {
    return this.run(async () => {
      await this.initialize();
      for (const mark of this.state.marks) {
        if (mark.status === 'reserved' || mark.status === 'partial')
          await this.commit(mark, [...participants, ...external(mark.pinId)]);
        if (mark.status === 'preparing') {
          mark.status = 'partial';
          mark.unavailable.push('interrupted-before-shared-reservation');
          await this.save();
        }
      }
      return structuredClone(this.state);
    });
  }
  snapshot() {
    return structuredClone(this.state);
  }
}

/** The document supplies an ID only. Read and verify the native receipt and each fixed file. */
export async function readHostPin(
  root: string,
  pinId: string,
  kind: 'incident' | 'export' | 'delivery' = 'incident',
): Promise<PinReceipt> {
  if (!UUID.test(pinId)) throw new Error('host_pin_id_invalid');
  const raw = await boundedJson<{
    schema: string;
    pinId: string;
    producerKind: string;
    producerRunId: string;
    kind: string;
    state: string;
    expiresAt: string | null;
    segments: { name: string; bytes: number; sha256: string }[];
    sourceState?: {
      postCutoffSegments?: string[];
      asOf: string;
      memoryOnly: { events: number | null; bytes: number | null };
      unreportedLoss: { overflow: number; contended: number; writeFailed: number };
      lossTotals?: {
        count: number;
        bytes: number;
        firstObservedAt: string | null;
        lastObservedAt: string | null;
      };
    };
  }>(root, `host-pins/${pinId}.json`);
  if (
    raw.schema !== 'mizar-producer-pin/2' ||
    raw.pinId !== pinId ||
    raw.producerKind !== 'host' ||
    raw.kind !== kind ||
    !['prepared', 'committed'].includes(raw.state) ||
    !UUID.test(raw.producerRunId) ||
    !Array.isArray(raw.segments) ||
    raw.segments.length > 4096 ||
    (raw.expiresAt !== null &&
      (!Number.isFinite(Date.parse(raw.expiresAt)) || Date.parse(raw.expiresAt) <= Date.now()))
  )
    throw new Error('host_pin_receipt_invalid');
  const segments: RetainedSegment[] = [];
  for (const value of raw.segments) {
    if (
      !immutableName.test(value.name) ||
      !/^(desktop|document)-/.test(value.name) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > 2 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw new Error('host_pin_source_invalid');
    const actual = await describe(root, value.name);
    if (actual.bytes !== value.bytes || actual.sha256 !== value.sha256)
      throw new Error('host_pin_source_changed');
    segments.push({
      ...actual,
      name: value.name,
      producerRunId: raw.producerRunId,
      firstSequence: null,
      lastSequence: null,
      firstObservedAt: null,
      lastObservedAt: null,
      records: 0,
      sealedAt: 'unknown',
    });
  }
  let sourceState: PinReceipt['sourceState'];
  if (raw.sourceState) {
    const state = raw.sourceState;
    const count = (value: unknown, maximum = Number.MAX_SAFE_INTEGER) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    if (
      !state.memoryOnly ||
      !state.unreportedLoss ||
      !Number.isFinite(Date.parse(state.asOf)) ||
      !(state.memoryOnly.events === null || count(state.memoryOnly.events, 256)) ||
      !(state.memoryOnly.bytes === null || count(state.memoryOnly.bytes, 512 * 1024)) ||
      ![
        state.unreportedLoss.overflow,
        state.unreportedLoss.contended,
        state.unreportedLoss.writeFailed,
      ].every((value) => count(value))
    )
      throw new Error('host_deferred_coverage_invalid');
    const totals = state.lossTotals;
    const timestamp = (value: unknown) =>
      value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
    if (
      totals &&
      (!count(totals.count) ||
        !count(totals.bytes) ||
        !timestamp(totals.firstObservedAt) ||
        !timestamp(totals.lastObservedAt))
    )
      throw new Error('host_deferred_coverage_invalid');
    const successors = state.postCutoffSegments;
    if (
      successors !== undefined &&
      (!Array.isArray(successors) ||
        successors.length > 2 ||
        successors.some(
          (name) =>
            typeof name !== 'string' ||
            !immutableName.test(name) ||
            !/^(desktop|document)-/.test(name) ||
            segments.some((segment) => segment.name === name),
        ))
    )
      throw new Error('host_pin_cutoff_invalid');
    sourceState = {
      ...(successors ? { postCutoffSegments: successors } : {}),
      asOf: state.asOf,
      memoryOnly: {
        included: false,
        events: state.memoryOnly.events,
        bytes: state.memoryOnly.bytes,
        reason: 'not-durably-committed',
      },
      unreportedLoss: {
        overflow: state.unreportedLoss.overflow,
        contended: state.unreportedLoss.contended,
        writeFailed: state.unreportedLoss.writeFailed,
      },
      ...(totals
        ? {
            lossTotals: {
              reason: 'native_event_loss_cumulative',
              count: totals.count,
              bytes: totals.bytes,
              firstObservedAt: totals.firstObservedAt,
              lastObservedAt: totals.lastObservedAt,
            },
          }
        : {}),
    };
  }
  return {
    pinId,
    producerId: 'host',
    status: raw.state as PinReceipt['status'],
    kind,
    expiresAt: raw.expiresAt === null ? null : Date.parse(raw.expiresAt),
    segments,
    confirmedAt: 'native-durable-receipt',
    ...(sourceState ? { sourceState } : {}),
  };
}
export function hostIncidentParticipant(root: string, pinId: string): IncidentParticipant {
  const read = async (id: string) => {
    if (id !== pinId) throw new Error('host_pin_id_mismatch');
    return readHostPin(root, pinId);
  };
  return {
    producerId: 'host',
    externalCommit: true,
    prepare: read,
    commit: read,
    release: async () => {
      throw new Error('host_pin_release_requires_native_owner');
    },
  };
}
