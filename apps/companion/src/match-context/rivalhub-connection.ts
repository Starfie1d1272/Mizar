import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import { validateBroadcastScheduleWindow } from '@mizar/rivalhub';
import { createOnlineManifestSource } from './http-source.js';
import type { ReliableDeliveryResult } from '../output/reliable-outbox.js';

type Installation = {
  baseUrl: string;
  credential: string;
  installationId: string;
  competitionId: string;
  displayName: string;
};
type Source = {
  matchId: string;
  authorityRevision: number;
  producerInstanceId: string;
  liveSessionId: string;
};

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('请输入 RivalHub 的 HTTPS 网站地址。');
  return url.origin;
}

/** Companion-owned scoped installation. Never exposed to the browser. */
export class RivalHubConnection {
  private installation: Installation | null = null;
  private source: Source | null = null;
  private activeDeviceName: string | null = null;

  constructor(
    private readonly path: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Installation;
      if (
        typeof parsed.credential === 'string' &&
        typeof parsed.installationId === 'string' &&
        typeof parsed.competitionId === 'string'
      )
        this.installation = { ...parsed, baseUrl: normalizeBaseUrl(parsed.baseUrl) };
    } catch {
      /* Missing or invalid connection is an unpaired local mode. */
    }
  }

  view() {
    return {
      paired: this.installation !== null,
      competitionId: this.installation?.competitionId ?? null,
      displayName: this.installation?.displayName ?? null,
      activeSourceMatchId: this.source?.matchId ?? null,
      activeDeviceName: this.activeDeviceName,
    };
  }

  async disconnect(): Promise<void> {
    await this.release();
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.installation = null;
    this.activeDeviceName = null;
  }

  private async persist(): Promise<void> {
    if (!this.installation) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = join(dirname(this.path), `.rivalhub-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(this.installation), { mode: 0o600 });
    await rename(temp, this.path);
  }

  private async request(operation: string, init: RequestInit = {}): Promise<Response> {
    if (!this.installation) throw new Error('请先连接 RivalHub。');
    return this.fetchImpl(`${this.installation.baseUrl}/api/mizar/${operation}`, {
      ...init,
      redirect: 'manual',
      headers: { authorization: `Bearer ${this.installation.credential}`, ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(4000),
    });
  }

  async pair(baseUrlInput: string, code: string, displayName: string): Promise<void> {
    const baseUrl = normalizeBaseUrl(baseUrlInput);
    if (!/^[A-Za-z0-9_-]{22}$/.test(code) || !displayName.trim() || displayName.length > 80)
      throw new Error('连接码或设备名称无效。');
    const response = await this.fetchImpl(`${baseUrl}/api/mizar/pair`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, displayName: displayName.trim() }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('连接码无效或已过期。');
    const value = (await response.json()) as {
      credential: string;
      installationId: string;
      competitionId: string;
    };
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value.credential) ||
      !value.installationId ||
      !value.competitionId
    )
      throw new Error('连接响应无效。');
    await this.release();
    this.installation = {
      baseUrl,
      credential: value.credential,
      installationId: value.installationId,
      competitionId: value.competitionId,
      displayName: displayName.trim(),
    };
    this.source = null;
    await this.persist();
  }

  async schedule(from: string, to: string) {
    const response = await this.request(
      `schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    if (!response.ok) throw new Error('赛事赛程暂时无法获取。');
    const result = validateBroadcastScheduleWindow(await response.json());
    if (!result.ok) throw new Error('赛事赛程格式不兼容。');
    return result.value;
  }

  matchSource(matchId: string) {
    if (!this.installation) throw new Error('请先连接 RivalHub。');
    return createOnlineManifestSource(matchId, {
      urlTemplate: `${this.installation.baseUrl}/api/mizar/match?matchId={matchId}`,
      readToken: this.installation.credential,
    });
  }

  async claim(snapshot: LiveSnapshotV1, contextRevision: string, takeover: boolean) {
    if (
      !this.installation ||
      snapshot.competitionId !== this.installation.competitionId ||
      !snapshot.cursor.liveSessionId
    )
      throw new Error('当前比赛尚未准备好连接。');
    const lineupSteam64 = snapshot.players
      .filter(
        (player) => player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
      )
      .map((player) => player.sourcePlayerId);
    const response = await this.request('claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        matchId: snapshot.matchId,
        producerInstanceId: snapshot.cursor.producerInstanceId,
        liveSessionId: snapshot.cursor.liveSessionId,
        programSourceGeneration: snapshot.cursor.programSourceGeneration,
        mapEpoch: snapshot.cursor.mapEpoch,
        contextRevision,
        takeover,
        lineupSteam64: lineupSteam64.length === 10 ? lineupSteam64 : [],
      }),
    });
    if (!response.ok) throw new Error('当前比赛无法成为数据源，请刷新比赛资料并核对首发。');
    const result = (await response.json()) as {
      claimed: boolean;
      authorityRevision: number;
      activeDeviceName?: string;
    };
    if (result.claimed) {
      this.source = {
        matchId: snapshot.matchId,
        authorityRevision: result.authorityRevision,
        producerInstanceId: snapshot.cursor.producerInstanceId,
        liveSessionId: snapshot.cursor.liveSessionId,
      };
      this.activeDeviceName = null;
    } else {
      this.source = null;
      this.activeDeviceName = result.activeDeviceName ?? '另一台制播设备';
    }
    return this.view();
  }

  async release(): Promise<void> {
    if (!this.source) return;
    const matchId = this.source.matchId;
    const response = await this.request('release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchId }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('当前数据源停止未确认。');
    this.source = null;
  }

  private async upload(
    operation: 'live' | 'reliable',
    body: unknown,
    matchId: string,
  ): Promise<ReliableDeliveryResult> {
    if (!this.source) return 'retry';
    if (this.source.matchId !== matchId) return 'rejected';
    try {
      const response = await this.request(operation, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rivalhub-authority': String(this.source.authorityRevision),
        },
        body: JSON.stringify(body),
      });
      await response.body?.cancel();
      if (response.ok) return 'accepted';
      if (response.status === 403) {
        this.source = null;
        this.activeDeviceName = '另一台制播设备';
        return 'rejected';
      }
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'retry'
        : 'rejected';
    } catch {
      return 'retry';
    }
  }

  async sendLive(snapshot: LiveSnapshotV1): Promise<void> {
    if ((await this.upload('live', snapshot, snapshot.matchId)) !== 'accepted')
      throw new Error('rivalhub_live_unavailable');
  }

  async sendReliable(
    event: ReliableEventV1,
    current: LiveSnapshotV1 | null,
  ): Promise<ReliableDeliveryResult> {
    const sameExecution =
      current?.matchId === event.matchId &&
      current.cursor.programSourceGeneration === event.cursor.programSourceGeneration &&
      current.cursor.mapEpoch === event.cursor.mapEpoch;
    const observed = sameExecution
      ? current.players
          .filter(
            (player) =>
              player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
          )
          .map((player) => player.sourcePlayerId)
      : [];
    return this.upload(
      'reliable',
      { event, lineupSteam64: observed.length === 10 ? observed : [] },
      event.matchId,
    );
  }
}
