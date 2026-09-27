import {
  BroadcastScheduleWindowConversionError,
  toScheduleWindow,
  validateBroadcastScheduleWindow,
  type ContractDiagnostic,
} from '@rivalhub-broadcast/rivalhub';

import { SerialCommitQueue } from './serial-commit.js';
import { SourceLoadError } from './source-error.js';
import {
  scheduleMatchesRequest,
  sameScheduleWindowRequest,
  type ScheduleWindowRequest,
} from './schedule-window-request.js';
import {
  ScheduleWindowLkgStore,
  type ScheduleWindowBinding,
  type ScheduleWindowSaveOptions,
  type ScheduleWindowStoreIssue,
} from './schedule-window-store.js';
import type { ScheduleWindowOrigin } from './schedule-window-store.js';

export interface ScheduleWindowSource {
  readonly kind: ScheduleWindowOrigin;
  /** The competition and exact time window this source load represents. */
  readonly request: ScheduleWindowRequest;
  /** Expected network/source failures must reject with SourceLoadError. */
  readonly load: () => Promise<unknown>;
}

export type ScheduleWindowControllerIssueCode =
  | 'schedule_source_failed'
  | 'schedule_source_invalid'
  | 'schedule_source_request_mismatch'
  | 'schedule_conversion_failed'
  | 'schedule_memory_fallback'
  | 'schedule_lkg_fallback'
  | 'schedule_lkg_unavailable'
  | 'schedule_lkg_persistence_failed'
  | 'schedule_refresh_stale';

export interface ScheduleWindowControllerIssue {
  readonly code: ScheduleWindowControllerIssueCode;
  readonly message: string;
  readonly diagnostics?: readonly ContractDiagnostic[];
  readonly storeIssue?: ScheduleWindowStoreIssue;
}

export interface ScheduleWindowRefreshSuccess {
  readonly ok: true;
  readonly binding: ScheduleWindowBinding;
  readonly diagnostics: readonly ScheduleWindowControllerIssue[];
}

export interface ScheduleWindowRefreshFailure {
  readonly ok: false;
  readonly diagnostics: readonly ScheduleWindowControllerIssue[];
}

export type ScheduleWindowRefreshResult =
  ScheduleWindowRefreshSuccess | ScheduleWindowRefreshFailure;

export interface ScheduleWindowControllerOptions {
  readonly lkgStore: ScheduleWindowLkgStore;
}

function controllerIssue(
  code: ScheduleWindowControllerIssueCode,
  message: string,
  details: Omit<ScheduleWindowControllerIssue, 'code' | 'message'> = {},
): ScheduleWindowControllerIssue {
  return { code, message, ...details };
}

/** Acquires ScheduleWindow sources and owns the latest-wins current binding. */
export class ScheduleWindowController {
  private readonly lkgStore: ScheduleWindowLkgStore;
  private readonly commitQueue = new SerialCommitQueue();
  private currentBinding: ScheduleWindowBinding | undefined;
  private refreshGeneration = 0;

  constructor(options: ScheduleWindowControllerOptions) {
    this.lkgStore = options.lkgStore;
  }

  getCurrent(): ScheduleWindowBinding | undefined {
    return this.currentBinding;
  }

  /** Cancel in-flight refreshes and remove the current schedule binding. */
  clearCurrent(): void {
    this.refreshGeneration += 1;
    this.currentBinding = undefined;
  }

  async refresh(source: ScheduleWindowSource): Promise<ScheduleWindowRefreshResult> {
    const generation = ++this.refreshGeneration;
    const isCurrent = () => generation === this.refreshGeneration;
    const request: ScheduleWindowRequest = { ...source.request };
    if (
      this.currentBinding !== undefined &&
      !sameScheduleWindowRequest(this.currentBinding.request, request)
    ) {
      this.currentBinding = undefined;
    }

    let candidate: unknown;
    try {
      candidate = await source.load();
    } catch (error: unknown) {
      if (!(error instanceof SourceLoadError)) throw error;
      return this.useFallback(generation, request, {
        code: 'schedule_source_failed',
        message: 'ScheduleWindow source 加载失败。',
      });
    }

    const validated = validateBroadcastScheduleWindow(candidate);
    if (!validated.ok) {
      return this.useFallback(generation, request, {
        code: 'schedule_source_invalid',
        message: 'ScheduleWindow source 未通过 validation。',
        diagnostics: validated.diagnostics,
      });
    }
    if (!scheduleMatchesRequest(request, validated.value)) {
      return this.useFallback(generation, request, {
        code: 'schedule_source_request_mismatch',
        message: 'ScheduleWindow source 返回的 competition 或时间窗口与请求不一致。',
      });
    }

    let window;
    try {
      window = toScheduleWindow(validated.value);
    } catch (error: unknown) {
      if (!(error instanceof BroadcastScheduleWindowConversionError)) throw error;
      return {
        ok: false,
        diagnostics: [
          controllerIssue(
            'schedule_conversion_failed',
            'ScheduleWindow candidate 无法转换为领域模型。',
            {
              diagnostics: error.diagnostics,
            },
          ),
        ],
      };
    }

    return this.commitQueue.run(async () => {
      if (!isCurrent()) return this.staleRefreshResult();

      const saved = await this.lkgStore.save(validated.value, source.kind, {
        canCommit: isCurrent,
      } satisfies ScheduleWindowSaveOptions);
      if (!isCurrent() || (!saved.ok && saved.issue.code === 'schedule_lkg_commit_stale')) {
        return this.staleRefreshResult();
      }

      const diagnostics: ScheduleWindowControllerIssue[] = [];
      if (!saved.ok) {
        diagnostics.push(
          controllerIssue(
            'schedule_lkg_persistence_failed',
            '当前 candidate 有效，但未能更新 ScheduleWindow LKG。',
            { storeIssue: saved.issue },
          ),
        );
      }
      const binding: ScheduleWindowBinding = {
        request,
        schedule: validated.value,
        window,
        origin: source.kind,
        freshness: 'fresh',
        diagnostics: validated.diagnostics,
      };
      this.currentBinding = binding;
      return { ok: true, binding, diagnostics };
    });
  }

  private async useFallback(
    generation: number,
    request: ScheduleWindowRequest,
    diagnostic: ScheduleWindowControllerIssue,
  ): Promise<ScheduleWindowRefreshResult> {
    return this.commitQueue.run(async () => {
      if (generation !== this.refreshGeneration) return this.staleRefreshResult();

      const current = this.currentBinding;
      if (current !== undefined && sameScheduleWindowRequest(current.request, request)) {
        const staleBinding: ScheduleWindowBinding = { ...current, freshness: 'stale' };
        this.currentBinding = staleBinding;
        return {
          ok: true,
          binding: staleBinding,
          diagnostics: [
            diagnostic,
            controllerIssue(
              'schedule_memory_fallback',
              'ScheduleWindow source 失败，继续使用当前内存 binding，并标记为 stale。',
            ),
          ],
        };
      }

      const fallback = await this.lkgStore.read(request);
      if (generation !== this.refreshGeneration) return this.staleRefreshResult();
      if (fallback.ok) {
        this.currentBinding = fallback.value;
        return {
          ok: true,
          binding: fallback.value,
          diagnostics: [
            diagnostic,
            controllerIssue('schedule_lkg_fallback', '已使用 stale ScheduleWindow LKG。'),
          ],
        };
      }

      return {
        ok: false,
        diagnostics: [
          diagnostic,
          controllerIssue('schedule_lkg_unavailable', '没有可用的 ScheduleWindow LKG。', {
            storeIssue: fallback.issue,
          }),
        ],
      };
    });
  }

  private staleRefreshResult(): ScheduleWindowRefreshFailure {
    return {
      ok: false,
      diagnostics: [
        controllerIssue(
          'schedule_refresh_stale',
          'ScheduleWindow refresh 已被更新的 refresh supersede。',
        ),
      ],
    };
  }
}

export function createScheduleWindowController(
  options: ScheduleWindowControllerOptions,
): ScheduleWindowController {
  return new ScheduleWindowController(options);
}
