import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ObsRpc } from './reconcile.js';

const videoSchema = z
  .object({
    baseWidth: z.number().int().positive(),
    baseHeight: z.number().int().positive(),
    outputWidth: z.number().int().positive(),
    outputHeight: z.number().int().positive(),
    fpsNumerator: z.number().int().positive(),
    fpsDenominator: z.number().int().positive(),
  })
  .strict();
type Video = z.infer<typeof videoSchema>;
const journalSchema = z
  .object({
    id: z.string().uuid(),
    endpoint: z.string().min(1),
    profile: z.string().min(1),
    before: videoSchema,
    applied: videoSchema,
    phase: z.enum(['prepared', 'sent', 'confirmed']),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const desired: Video = {
  baseWidth: 1920,
  baseHeight: 1080,
  outputWidth: 1920,
  outputHeight: 1080,
  fpsNumerator: 60,
  fpsDenominator: 1,
};
const pairs = [
  ['baseWidth', 'baseHeight'],
  ['outputWidth', 'outputHeight'],
  ['fpsNumerator', 'fpsDenominator'],
] as const;

export class ObsVideoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ObsVideoError';
  }
}

/** Output precheck failed before the guarded OBS mutation was dispatched. */
export class ObsPreparationWriteBlocked extends ObsVideoError {
  constructor(cause: unknown) {
    super(
      cause instanceof ObsVideoError ? cause.code : 'outputs_unknown',
      cause instanceof ObsVideoError ? cause.message : '无法确认 OBS 输出状态，请重新连接后重试。',
      { cause },
    );
    this.name = 'ObsPreparationWriteBlocked';
  }
}

function video(value: Record<string, unknown>): Video {
  return videoSchema.parse(
    Object.fromEntries(Object.keys(desired).map((key) => [key, value[key]])),
  );
}
async function current(obs: ObsRpc): Promise<{ profile: string; video: Video }> {
  const profile = (await obs.call('GetProfileList')).currentProfileName;
  if (typeof profile !== 'string' || !profile)
    throw new ObsVideoError('profile_unknown', '无法确认 OBS 当前配置档，请重新连接后重试。');
  const settings = video(await obs.call('GetVideoSettings'));
  if ((await obs.call('GetProfileList')).currentProfileName !== profile)
    throw new ObsVideoError('profile_changed', 'OBS 配置档已变化，请重试。');
  return { profile, video: settings };
}
function samePair(a: Video, b: Video, pair: (typeof pairs)[number]): boolean {
  return pair.every((key) => a[key] === b[key]);
}
function changes(before: Video, after: Video): Partial<Video> {
  const result: Partial<Video> = {};
  for (const pair of pairs)
    if (!samePair(before, after, pair)) {
      for (const key of pair) result[key] = after[key];
    }
  return result;
}

function targetVideo(before: Video): Video {
  // Equivalent fractions represent the same FPS. Preserve the operator's exact pair.
  return before.fpsNumerator === 60 * before.fpsDenominator
    ? { ...desired, fpsNumerator: before.fpsNumerator, fpsDenominator: before.fpsDenominator }
    : desired;
}
function reusable(journal: Journal, state: { profile: string; video: Video }, endpoint: string) {
  return (
    journal.phase === 'confirmed' &&
    journal.endpoint === endpoint &&
    journal.profile === state.profile &&
    pairs.every((pair) => samePair(journal.applied, state.video, pair)) &&
    Object.keys(changes(state.video, targetVideo(state.video))).length === 0
  );
}
export async function assertNoVideoOutput(obs: ObsRpc): Promise<void> {
  const list = (await obs.call('GetOutputList')).outputs;
  if (!Array.isArray(list))
    throw new ObsVideoError('outputs_unknown', '无法确认 OBS 输出状态，请重新连接后重试。');
  const active: string[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw new ObsVideoError('outputs_unknown', '无法确认 OBS 输出状态，请重新连接后重试。');
    const entry = item as Record<string, unknown>;
    const flags = entry.outputFlags as Record<string, unknown> | undefined;
    if (
      typeof entry.outputName !== 'string' ||
      typeof entry.outputActive !== 'boolean' ||
      typeof flags?.OBS_OUTPUT_VIDEO !== 'boolean'
    )
      throw new ObsVideoError('outputs_unknown', '无法确认 OBS 输出状态，请重新连接后重试。');
    if (entry.outputActive && flags.OBS_OUTPUT_VIDEO) active.push(entry.outputName);
  }
  if (active.length)
    throw new ObsVideoError(
      'video_output_active',
      `OBS 视频输出“${active.join('、')}”正在运行；请停止该输出后重试。`,
    );
}

/** Explicit workbench operation only. A persisted journal survives process and request failure. */
export class ObsVideoTransaction {
  constructor(private readonly path: string) {}
  async pending(): Promise<boolean> {
    return (await this.read()) !== null;
  }
  private async read(): Promise<Journal | null> {
    try {
      return journalSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async save(journal: Journal, create = false): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      if (create) await link(temp, this.path);
      else await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async preflight(obs: ObsRpc, endpoint: string): Promise<void> {
    const previous = await this.read();
    const state = await current(obs);
    if (
      previous &&
      previous.phase !== 'prepared' &&
      (previous.endpoint !== endpoint || previous.profile !== state.profile)
    )
      throw new ObsVideoError(
        'restore_profile_changed',
        '上次 OBS 视频设置待恢复；请切回原配置档后重试。',
      );
    if (
      (previous && previous.phase !== 'prepared' && !reusable(previous, state, endpoint)) ||
      Object.keys(changes(state.video, targetVideo(state.video))).length
    )
      await assertNoVideoOutput(obs);
  }
  async prepare(obs: ObsRpc, endpoint: string, valid: () => boolean): Promise<string | null> {
    const previous = await this.read();
    if (previous?.phase === 'confirmed') {
      const state = await current(obs);
      if (reusable(previous, state, endpoint)) {
        const latest = await current(obs);
        if (!valid() || !reusable(previous, latest, endpoint))
          throw new ObsVideoError('video_changed', 'OBS 视频设置已变化，请重试。');
        // A delayed cancellation from the old attempt must not revoke this one.
        previous.id = randomUUID();
        await this.save(previous);
        if (!valid()) {
          try {
            await this.restore(obs, endpoint, previous.id);
          } catch (error) {
            throw new ObsVideoError(
              'restore_pending',
              'OBS 视频设置恢复待完成，请检查输出和配置档后重试。',
              { cause: error },
            );
          }
          throw new ObsVideoError('cancelled', '准备已取消。');
        }
        return previous.id;
      }
    }
    if (previous) await this.restore(obs, endpoint, undefined, valid);
    const initial = await current(obs);
    const patch = changes(initial.video, targetVideo(initial.video));
    if (!Object.keys(patch).length) return null;
    await assertNoVideoOutput(obs);
    const journal: Journal = {
      id: randomUUID(),
      endpoint,
      profile: initial.profile,
      before: initial.video,
      applied: { ...initial.video, ...patch },
      phase: 'prepared',
    };
    await this.save(journal, true);
    try {
      const latest = await current(obs);
      if (
        !valid() ||
        latest.profile !== initial.profile ||
        pairs.some((pair) => !samePair(latest.video, initial.video, pair))
      )
        throw new ObsVideoError('video_changed', 'OBS 视频设置已变化，请重试。');
      await assertNoVideoOutput(obs);
      if (!valid()) throw new ObsVideoError('cancelled', '准备已取消。');
      journal.phase = 'sent';
      await this.save(journal);
      await obs.call('SetVideoSettings', patch);
      const result = await current(obs);
      if (
        result.profile !== journal.profile ||
        pairs.some((pair) => !samePair(result.video, journal.applied, pair))
      )
        throw new ObsVideoError('video_unconfirmed', 'OBS 视频设置未确认，请重试。');
      journal.phase = 'confirmed';
      await this.save(journal);
      if (!valid()) throw new ObsVideoError('cancelled', '准备已取消。');
      return journal.id;
    } catch (error) {
      // An uncertain RPC is read back and restored; never blindly replay a write.
      try {
        await this.restore(obs, endpoint, journal.id);
      } catch (restoreError) {
        throw new ObsVideoError(
          'restore_pending',
          'OBS 视频设置恢复待完成，请检查输出和配置档后重试。',
          { cause: restoreError },
        );
      }
      // The output may have started after the preflight but before OBS handled the write.
      try {
        await assertNoVideoOutput(obs);
      } catch (outputError) {
        if (outputError instanceof ObsVideoError && outputError.code === 'video_output_active')
          throw outputError;
      }
      throw error;
    }
  }
  async restore(
    obs: ObsRpc,
    endpoint: string,
    id?: string,
    valid: () => boolean = () => true,
  ): Promise<void> {
    const journal = await this.read();
    if (!journal || (id !== undefined && id !== journal.id)) return;
    if (!valid()) throw new ObsVideoError('cancelled', '准备已取消。');
    if (journal.phase === 'prepared') {
      await rm(this.path);
      return;
    }
    const state = await current(obs);
    if (journal.endpoint !== endpoint || journal.profile !== state.profile)
      throw new ObsVideoError(
        'restore_profile_changed',
        '上次 OBS 视频设置待恢复；请切回原配置档后重试。',
      );
    const patch: Partial<Video> = {};
    for (const pair of pairs) {
      if (
        samePair(journal.before, journal.applied, pair) ||
        !samePair(state.video, journal.applied, pair)
      )
        continue;
      for (const key of pair) patch[key] = journal.before[key];
    }
    if (Object.keys(patch).length) {
      await assertNoVideoOutput(obs);
      const latest = await current(obs);
      if (
        latest.profile !== journal.profile ||
        pairs.some((pair) => !samePair(latest.video, state.video, pair))
      )
        throw new ObsVideoError('video_changed', 'OBS 视频设置已变化，请重试恢复。');
      if (!valid()) throw new ObsVideoError('cancelled', '准备已取消。');
      try {
        await obs.call('SetVideoSettings', patch);
      } catch (error) {
        // An output can start after the read. Reinspect to give the affected output
        // when OBS rejects the write; never stop it or retry the mutation.
        try {
          await assertNoVideoOutput(obs);
        } catch (outputError) {
          if (outputError instanceof ObsVideoError && outputError.code === 'video_output_active')
            throw outputError;
        }
        throw error;
      }
      const result = await current(obs);
      if (
        result.profile !== journal.profile ||
        Object.entries(patch).some(([key, value]) => result.video[key as keyof Video] !== value)
      )
        throw new ObsVideoError('restore_unconfirmed', 'OBS 视频设置恢复未确认，请重试。');
    }
    await rm(this.path);
  }
}
