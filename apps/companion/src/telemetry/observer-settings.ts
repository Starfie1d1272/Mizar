import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  observerSettingsSchema,
  gameAutomationSettingsSchema,
  DEFAULT_GAME_AUTOMATION_SETTINGS,
  type GameAutomationSettings,
  DEFAULT_OBSERVER_SETTINGS,
  observerConnectionSchema,
  formatObserverConnection,
  type ObserverSettings,
  type ObserverConnection,
} from '@mizar/protocol/assist';
import { atomicJson } from '../resource-store/files.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

type SettingsChange = 'settings' | 'lead' | 'enabled' | 'game' | 'connection' | 'map';

/** Persist operator preferences; the current match's credentials stay in memory. */
export class ObserverSettingsStore {
  settings: ObserverSettings = { ...DEFAULT_OBSERVER_SETTINGS };
  gameAutomation: GameAutomationSettings = { ...DEFAULT_GAME_AUTOMATION_SETTINGS };
  private connection: ObserverConnection | undefined;
  mapConnection: { id: string; mode: 'connect' | 'seamless'; nextMap: boolean } | undefined;
  waitingForMap = false;
  revision = randomUUID();
  private listeners = new Set<(kind: SettingsChange) => void>();
  private writing = Promise.resolve();
  constructor(private readonly path?: string) {}
  async load() {
    if (!this.path) return;
    try {
      const saved: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const record = saved as Record<string, unknown>;
        const current = { ...((record.settings ?? record) as Record<string, unknown>) };
        // Read the preview format while keeping each capability's current preferences.
        const legacyHud = current.hideGameHud;
        delete current.displaySeconds;
        delete current.hideGameHud;
        this.settings = observerSettingsSchema.parse(current);
        this.gameAutomation = gameAutomationSettingsSchema.parse(
          record.gameAutomation ?? {
            ...DEFAULT_GAME_AUTOMATION_SETTINGS,
            ...(typeof legacyHud === 'boolean' ? { hideGameHud: legacyHud } : {}),
          },
        );
      } else this.settings = observerSettingsSchema.parse(saved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  view() {
    return {
      settings: this.settings,
      gameAutomation: this.gameAutomation,
      revision: this.revision,
      mapConnection: this.mapConnection ?? null,
      waitingForMap: this.waitingForMap,
      connection: this.connection
        ? {
            earlyEndpoint: this.connection.earlyEndpoint,
            programEndpoint: this.connection.programEndpoint,
            passwordProvided: Boolean(this.connection.password),
          }
        : null,
    };
  }
  configured() {
    return this.connection;
  }
  configure(settings: ObserverSettings) {
    const value = observerSettingsSchema.parse(settings);
    const next = this.writing.then(async () => {
      if (JSON.stringify(this.settings) === JSON.stringify(value)) return;
      if (this.path)
        await atomicJson(this.path, { settings: value, gameAutomation: this.gameAutomation });
      const kind =
        this.settings.enabled !== value.enabled
          ? 'enabled'
          : this.settings.expectedDelaySeconds !== value.expectedDelaySeconds
            ? 'settings'
            : 'lead';
      this.settings = value;
      this.changed(kind);
    });
    this.writing = next.catch(() => {});
    return next;
  }
  configureGame(value: GameAutomationSettings) {
    const gameAutomation = gameAutomationSettingsSchema.parse(value);
    const next = this.writing.then(async () => {
      if (JSON.stringify(this.gameAutomation) === JSON.stringify(gameAutomation)) return;
      if (this.path) await atomicJson(this.path, { settings: this.settings, gameAutomation });
      this.gameAutomation = gameAutomation;
      this.changed('game');
    });
    this.writing = next.catch(() => {});
    return next;
  }
  setConnection(value: ObserverConnection) {
    const connection = observerConnectionSchema.parse(value);
    if (JSON.stringify(this.connection) === JSON.stringify(connection)) return;
    this.connection = connection;
    this.mapConnection = undefined;
    this.waitingForMap = false;
    this.changed('connection');
  }
  setMapConnection(
    id: string,
    mode: 'connect' | 'seamless',
    value?: ObserverConnection,
    nextMap = false,
  ) {
    const connection = value ? observerConnectionSchema.parse(value) : this.connection;
    if (!connection) throw new Error('connection_required');
    if (this.mapConnection?.id === id) {
      if (
        this.mapConnection.mode !== mode ||
        this.mapConnection.nextMap !== (nextMap || mode === 'seamless') ||
        JSON.stringify(connection) !== JSON.stringify(this.connection)
      )
        throw new Error('map_intent_conflict');
      return;
    }
    if (mode === 'seamless' && JSON.stringify(connection) !== JSON.stringify(this.connection))
      throw new Error('seamless_connection_changed');
    this.connection = connection;
    this.mapConnection = { id, mode, nextMap: nextMap || mode === 'seamless' };
    this.changed('map');
  }
  clearConnection() {
    if (!this.connection) return;
    this.connection = undefined;
    this.mapConnection = undefined;
    this.waitingForMap = false;
    this.changed('connection');
  }
  endProduction() {
    if (!this.mapConnection && !this.waitingForMap) return;
    this.mapConnection = undefined;
    this.waitingForMap = false;
    this.changed('connection');
  }
  subscribe(listener: (kind: SettingsChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(kind: SettingsChange) {
    // Timing preferences affect projection calculation, never Host preparation.
    if (kind !== 'settings' && kind !== 'lead') this.revision = randomUUID();
    this.listeners.forEach((f) => f(kind));
  }
}

export function registerObserverSettings(
  app: FastifyInstance,
  store: ObserverSettingsStore,
  policy: LocalWebOriginPolicy,
) {
  app.get('/local/v1/observer-assist', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(store.view()),
  );
  const schema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('configure'), settings: observerSettingsSchema }),
    z.strictObject({
      action: z.literal('connection'),
      connection: observerConnectionSchema,
      expectedRevision: z.uuid().optional(),
    }),
    z.strictObject({
      action: z.literal('map-connection'),
      id: z.uuid(),
      mode: z.enum(['connect', 'seamless']),
      nextMap: z.boolean().default(false),
      connection: observerConnectionSchema.optional(),
      expectedRevision: z.uuid(),
    }),
    z.strictObject({ action: z.literal('configure-game'), settings: gameAutomationSettingsSchema }),
    z.strictObject({ action: z.literal('copy-connection'), expectedRevision: z.uuid() }),
  ]);
  app.post('/operator/observer-assist', { bodyLimit: 4096 }, async (request, reply) => {
    if (policy.mode !== 'loopback' || !checkLocalWebOrigin(policy, request.headers.origin).allowed)
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ message: '请核对时间设置、GOTV 地址和密码格式。' });
    if (parsed.data.action === 'copy-connection') {
      const connection = store.configured();
      if (parsed.data.expectedRevision !== store.revision || !connection)
        return reply.code(409).send({ message: '本图连接已变化，请重新打开后复制。' });
      return reply
        .header('cache-control', 'no-store')
        .send({ command: formatObserverConnection(connection) });
    }
    if (parsed.data.action === 'configure') await store.configure(parsed.data.settings);
    else if (parsed.data.action === 'configure-game')
      await store.configureGame(parsed.data.settings);
    else {
      if (parsed.data.expectedRevision && parsed.data.expectedRevision !== store.revision)
        return reply
          .code(409)
          .send({ message: '本场连接或比赛已变化，请重新打开本场连接后确认。' });
      if (parsed.data.action === 'map-connection') {
        try {
          store.setMapConnection(
            parsed.data.id,
            parsed.data.mode,
            parsed.data.connection,
            parsed.data.nextMap,
          );
        } catch (error) {
          if (error instanceof Error && error.message === 'map_intent_conflict')
            return reply.code(409).send({ message: '本图连接意图已变化，请重新确认。' });
          return reply.code(400).send({ message: '请填写本图连接；无缝换图只能沿用已有连接。' });
        }
      } else store.setConnection(parsed.data.connection);
    }
    return store.view();
  });
}
