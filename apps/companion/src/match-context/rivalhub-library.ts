import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  validateBroadcastManifest,
  validateBroadcastScheduleWindow,
  toMatchDocumentV1,
} from '@mizar/rivalhub';
type MatchDocumentV1 = ReturnType<typeof toMatchDocumentV1>;

type Schedule = Extract<ReturnType<typeof validateBroadcastScheduleWindow>, { ok: true }>['value'];
type Entry = {
  document: MatchDocumentV1;
  etag: string | null;
  checkedAt: string;
  updatedAt: string;
};
type Saved = { schedule: Schedule; entries: Record<string, Entry>; syncedAt: string | null };

/** Browsing cache only. It never activates a match or supplies production authority. */
export class RivalHubLibrary {
  private saved: Saved | null = null;
  private running: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private discovered: Promise<void> | null = null;
  private markDiscovered: (() => void) | null = null;
  private attemptedAt = -Infinity;
  private error: string | null = null;
  constructor(
    private readonly path: string,
    private readonly competitionId: string,
    private readonly schedule: (from: string, to: string) => Promise<Schedule>,
    private readonly readManifest: (matchId: string, fresh: boolean) => Promise<unknown>,
    private readonly now = () => Date.now(),
  ) {}

  private async load() {
    try {
      const input = JSON.parse(await readFile(this.path, 'utf8')) as Saved;
      const schedule = validateBroadcastScheduleWindow(input.schedule);
      // Stored normalized documents are never trusted as online input: only restore schedule.
      // Details are revalidated from the stored provider manifest below.
      if (schedule.ok && schedule.value.competition.competitionId === this.competitionId) {
        // Disk keeps browsed match details across upgrades, but operator identity and
        // assignments must come from the current scope's fresh schedule response.
        const cachedSchedule = {
          ...schedule.value,
          matches: schedule.value.matches.map((row) => {
            const cached = { ...row };
            delete cached.assignedToViewer;
            return cached;
          }),
        };
        delete cachedSchedule.viewer;
        this.saved = { schedule: cachedSchedule, entries: {}, syncedAt: null };
        const manifests =
          (input as Saved & { manifests?: Record<string, unknown> }).manifests ?? {};
        for (const row of schedule.value.matches) {
          const valid = validateBroadcastManifest(manifests[row.matchId]);
          if (
            valid.ok &&
            valid.value.match.matchId === row.matchId &&
            valid.value.match.competition?.competitionId === this.competitionId
          ) {
            const metadata = input.entries?.[row.matchId];
            if (
              !metadata ||
              !Number.isFinite(Date.parse(metadata.checkedAt)) ||
              !Number.isFinite(Date.parse(metadata.updatedAt))
            )
              continue;
            this.manifests[row.matchId] = valid.value;
            this.saved.entries[row.matchId] = {
              document: toMatchDocumentV1(valid.value),
              etag: typeof metadata.etag === 'string' ? metadata.etag : null,
              checkedAt: metadata.checkedAt,
              updatedAt: metadata.updatedAt,
            };
          }
        }
        this.saved.syncedAt =
          typeof input.syncedAt === 'string' && Number.isFinite(Date.parse(input.syncedAt))
            ? input.syncedAt
            : null;
      }
    } catch {
      /* A missing/invalid browsing cache is rebuilt from the website. */
    }
  }

  async view() {
    await (this.loading ??= this.load());
    if (!this.running && this.now() - this.attemptedAt >= 60_000) {
      this.attemptedAt = this.now();
      this.discovered = new Promise<void>((resolve) => {
        this.markDiscovered = resolve;
      });
      this.running = this.refresh()
        .catch(() => {
          this.error = '网站暂时无法连接，保留上次缓存。';
        })
        .finally(() => {
          this.markDiscovered?.();
          this.running = null;
        });
    }
    // Initial discovery needs the schedule; subsequent reads remain responsive during refresh.
    if (!this.saved) await this.discovered;
    if (!this.saved) throw new Error('赛事赛程暂时无法获取。');
    const boundary = this.now();
    const matches = this.saved.schedule.matches.filter(
      (row) =>
        row.scheduledAt === null ||
        (Date.parse(row.scheduledAt) >= boundary - 14 * 86400_000 &&
          Date.parse(row.scheduledAt) <= boundary + 14 * 86400_000),
    );
    return {
      ...this.saved.schedule,
      matches,
      library: {
        entries: Object.fromEntries(
          matches.flatMap((row) =>
            this.saved!.entries[row.matchId]
              ? [[row.matchId, this.saved!.entries[row.matchId]]]
              : [],
          ),
        ),
        syncedAt: this.saved.syncedAt,
        refreshing: this.running !== null,
        error: this.error,
      },
    };
  }
  private manifests: Record<string, unknown> = {};
  private async refresh() {
    const now = this.now();
    const schedule = await this.schedule(
      new Date(now - 14 * 86400_000).toISOString(),
      new Date(now + 14 * 86400_000).toISOString(),
    );
    if (schedule.competition.competitionId !== this.competitionId) throw new Error('赛事不匹配。');
    this.saved = {
      schedule,
      entries: this.saved?.entries ?? {},
      syncedAt: this.saved?.syncedAt ?? null,
    };
    this.markDiscovered?.();
    this.error = null;
    const ids = new Set(schedule.matches.map((row) => row.matchId));
    this.saved.entries = Object.fromEntries(
      Object.entries(this.saved.entries).filter(([id]) => ids.has(id)),
    );
    this.manifests = Object.fromEntries(
      Object.entries(this.manifests).filter(([id]) => ids.has(id)),
    );
    this.saved.syncedAt = new Date(this.now()).toISOString();
    await this.persist();
  }

  async detail(matchId: string, fresh = true) {
    await this.view();
    if (!this.saved?.schedule.matches.some((row) => row.matchId === matchId))
      throw new Error('比赛不在当前赛事赛程中。');
    try {
      const valid = validateBroadcastManifest(await this.readManifest(matchId, fresh));
      if (
        !valid.ok ||
        valid.value.match.matchId !== matchId ||
        valid.value.match.competition?.competitionId !== this.competitionId
      )
        throw new Error('比赛资料不匹配。');
      const checkedAt = new Date(this.now()).toISOString();
      const previous = this.saved.entries[matchId];
      const changed = JSON.stringify(this.manifests[matchId]) !== JSON.stringify(valid.value);
      const entry = {
        document: toMatchDocumentV1(valid.value),
        etag: null,
        checkedAt,
        updatedAt: changed || !previous ? checkedAt : previous.updatedAt,
      };
      this.manifests[matchId] = valid.value;
      this.saved.entries[matchId] = entry;
      await this.persist();
      return { entry, error: null };
    } catch {
      return {
        entry: this.saved.entries[matchId] ?? null,
        error: this.saved.entries[matchId]
          ? '网站暂时无法连接，显示上次浏览的资料；载入前会重新核对。'
          : '完整资料尚未缓存，离线时无法查看。请连接网站后重试。',
      };
    }
  }

  private writing: Promise<void> = Promise.resolve();
  private persist() {
    const content = JSON.stringify({ ...this.saved, manifests: this.manifests });
    const write = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporary, content, {
          mode: 0o600,
        });
        await rename(temporary, this.path);
      });
    this.writing = write;
    return write;
  }
}
