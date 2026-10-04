import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  getBuiltinResolvedPreset,
  parseHudConfigDocument,
  parseHudResolvedPreset,
  type HudConfigDocument,
  type HudResolvedPreset,
} from '@mizar/hud-config';

export const HUD_CONFIG_POLL_INTERVAL_MS = 500;

export interface HudConfigResponse {
  readonly resolved: HudResolvedPreset;
  readonly etag: string;
  readonly activeRevision: string;
}

export interface HudConfigEditorResponse {
  readonly document: HudConfigDocument;
  readonly activationStale: boolean;
  readonly etag: string;
  readonly revision: string;
}

export interface HudConfigCommandResult {
  readonly kind: 'save-resource' | 'save-as' | 'activate-preset' | 'import-preset-pack';
  readonly resource?: 'preset' | 'layout' | 'theme';
  readonly resourceId?: string;
  readonly sourceId?: string;
}

export interface HudConfigMutationResponse {
  readonly command: HudConfigCommandResult;
  readonly onAir: HudConfigResponse;
  readonly editor: HudConfigEditorResponse;
}

export class HudConfigMutationError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = 'HudConfigMutationError';
    this.status = status;
    this.code = code;
  }
}

export interface HudConfigClientSnapshot {
  readonly status: 'loading' | 'ready' | 'error';
  readonly current: HudResolvedPreset;
  readonly etag: string | null;
  readonly activeRevision: string | null;
  readonly error: string | null;
}

export interface HudConfigEditorClientSnapshot {
  readonly status: 'loading' | 'ready' | 'error';
  readonly document: HudConfigDocument | null;
  readonly etag: string | null;
  readonly revision: string | null;
  readonly activationStale: boolean;
  readonly error: string | null;
}

export type HudConfigClientListener = () => void;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('HUD 配置响应结构无法识别');
  }
  return value as Record<string, unknown>;
}

function parseOnAirResponse(value: unknown): HudConfigResponse {
  const record = asRecord(value);
  if (typeof record.etag !== 'string' || typeof record.activeRevision !== 'string') {
    throw new Error('播出画面配置响应缺少版本信息');
  }
  let resolved: HudResolvedPreset;
  try {
    resolved = parseHudResolvedPreset(record.resolved);
  } catch {
    throw new Error('播出画面配置响应无效');
  }
  return { resolved, etag: record.etag, activeRevision: record.activeRevision };
}

function parseEditorResponse(value: unknown): HudConfigEditorResponse {
  const record = asRecord(value);
  if (
    typeof record.etag !== 'string' ||
    typeof record.revision !== 'string' ||
    typeof record.activationStale !== 'boolean'
  ) {
    throw new Error('HUD 编辑配置响应缺少版本信息');
  }
  return {
    document: parseHudConfigDocument(record.document),
    activationStale: record.activationStale,
    etag: record.etag,
    revision: record.revision,
  };
}

function parseMutationResponse(value: unknown): HudConfigMutationResponse {
  const record = asRecord(value);
  const command = asRecord(record.command);
  if (
    (command.kind !== 'save-resource' &&
      command.kind !== 'save-as' &&
      command.kind !== 'activate-preset' &&
      command.kind !== 'import-preset-pack') ||
    (command.resource !== undefined &&
      command.resource !== 'preset' &&
      command.resource !== 'layout' &&
      command.resource !== 'theme') ||
    (command.resourceId !== undefined && typeof command.resourceId !== 'string') ||
    (command.sourceId !== undefined && typeof command.sourceId !== 'string')
  ) {
    throw new Error('HUD 操作结果缺少资源身份');
  }
  const parsedCommand: HudConfigCommandResult = {
    kind: command.kind,
    ...(typeof command.resource === 'string' ? { resource: command.resource } : {}),
    ...(typeof command.resourceId === 'string' ? { resourceId: command.resourceId } : {}),
    ...(typeof command.sourceId === 'string' ? { sourceId: command.sourceId } : {}),
  };
  return {
    command: parsedCommand,
    onAir: parseOnAirResponse(record.onAir),
    editor: parseEditorResponse(record.editor),
  };
}

export class HudConfigClient {
  private snapshot: HudConfigClientSnapshot = {
    status: 'loading',
    current: getBuiltinResolvedPreset(),
    etag: null,
    activeRevision: null,
    error: null,
  };
  private readonly listeners = new Set<HudConfigClientListener>();
  private timer: number | undefined;
  private running = false;
  private requestInFlight = false;

  getSnapshot = (): HudConfigClientSnapshot => this.snapshot;

  subscribe = (listener: HudConfigClientListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private update(patch: Partial<HudConfigClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  applyResponse = (response: HudConfigResponse): void => {
    this.update({
      status: 'ready',
      current: response.resolved,
      etag: response.etag,
      activeRevision: response.activeRevision,
      error: null,
    });
  };

  private schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, HUD_CONFIG_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.running || this.requestInFlight) return;
    this.requestInFlight = true;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.snapshot.etag !== null) headers['If-None-Match'] = this.snapshot.etag;
      const response = await fetch('/local/v1/hud-config', { headers, cache: 'no-store' });
      if (response.status === 304) {
        this.update({ status: 'ready', error: null });
      } else {
        if (!response.ok) throw new Error(`本地制播服务返回 HTTP ${response.status}`);
        this.applyResponse(parseOnAirResponse(await response.json()));
      }
    } catch (error: unknown) {
      this.update({
        status: 'error',
        error:
          error instanceof Error ? error.message : '播出画面配置暂不可用，继续使用最近有效版本',
      });
    } finally {
      this.requestInFlight = false;
      this.schedule();
    }
  }
}

export class HudConfigEditorClient {
  private snapshot: HudConfigEditorClientSnapshot = {
    status: 'loading',
    document: null,
    etag: null,
    revision: null,
    activationStale: false,
    error: null,
  };
  private readonly listeners = new Set<HudConfigClientListener>();
  private timer: number | undefined;
  private running = false;
  private requestInFlight = false;

  getSnapshot = (): HudConfigEditorClientSnapshot => this.snapshot;

  subscribe = (listener: HudConfigClientListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private update(patch: Partial<HudConfigEditorClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  applyResponse = (response: HudConfigEditorResponse): void => {
    this.update({
      status: 'ready',
      document: response.document,
      etag: response.etag,
      revision: response.revision,
      activationStale: response.activationStale,
      error: null,
    });
  };

  private schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, HUD_CONFIG_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.running || this.requestInFlight) return;
    this.requestInFlight = true;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.snapshot.etag !== null) headers['If-None-Match'] = this.snapshot.etag;
      const response = await fetch('/operator/hud-config', { headers, cache: 'no-store' });
      if (response.status === 304) {
        this.update({ status: 'ready', error: null });
      } else {
        if (!response.ok) throw new Error(`本地制播服务返回 HTTP ${response.status}`);
        this.applyResponse(parseEditorResponse(await response.json()));
      }
    } catch (error: unknown) {
      this.update({
        status: 'error',
        error: error instanceof Error ? error.message : 'HUD 配置暂不可用，继续使用最近有效版本',
      });
    } finally {
      this.requestInFlight = false;
      this.schedule();
    }
  }
}

export type HudConfigClientView = HudConfigClientSnapshot & {
  readonly applyResponse: (response: HudConfigResponse) => void;
};

export type HudConfigEditorClientView = HudConfigEditorClientSnapshot & {
  readonly applyResponse: (response: HudConfigEditorResponse) => void;
};

export function useHudConfigClient(enabled = true): HudConfigClientView {
  const client = useMemo(() => new HudConfigClient(), []);
  useEffect(() => {
    if (!enabled) return;
    client.start();
    return () => client.stop();
  }, [client, enabled]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return useMemo(() => ({ ...snapshot, applyResponse: client.applyResponse }), [client, snapshot]);
}

export function useHudConfigEditorClient(enabled = true): HudConfigEditorClientView {
  const client = useMemo(() => new HudConfigEditorClient(), []);
  useEffect(() => {
    if (!enabled) return;
    client.start();
    return () => client.stop();
  }, [client, enabled]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return useMemo(() => ({ ...snapshot, applyResponse: client.applyResponse }), [client, snapshot]);
}

export interface HudConfigMutation {
  readonly kind: 'save-resource' | 'save-as' | 'activate-preset' | 'import-preset-pack';
  readonly resource?: 'preset' | 'layout' | 'theme';
  readonly value?: unknown;
  readonly sourceId?: string;
  readonly expectedEditorRevision: string;
}

export async function mutateHudConfig(
  command: HudConfigMutation,
): Promise<HudConfigMutationResponse> {
  const response = await fetch('/operator/hud-config', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const bodyRecord =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const code = typeof bodyRecord?.error === 'string' ? bodyRecord.error : null;
    const message =
      response.status === 409
        ? '已在另一页面更新，请先处理冲突。'
        : response.status >= 500
          ? 'HUD 配置暂时无法保存，请查看本机诊断日志。'
          : typeof bodyRecord?.message === 'string'
            ? bodyRecord.message
            : 'HUD 操作参数无效。';
    throw new HudConfigMutationError(response.status, message, code);
  }
  return parseMutationResponse(body);
}
