import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  BUILTIN_PRESET_IDS,
  canonicalJson,
  createDefaultHudConfigDocument,
  getBuiltinLayouts,
  getBuiltinResolvedPreset,
  getBuiltinThemes,
  hudThemeSchema,
  parseHudConfigDocument,
  parseHudLayout,
  parseHudPreset,
  resolveActiveHudPreset,
  resolveHudPreset,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudResolvedPreset,
  type HudTheme,
} from '@mizar/hud-config';
import { replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';

export type HudResourceKind = 'preset' | 'layout' | 'theme';
export type HudResource = HudPreset | HudLayout | HudTheme;

export interface HudConfigStoreOptions {
  readonly filePath?: string;
  readonly onDiagnostic?: (code: string) => void;
}

export class HudConfigEditorConflictError extends Error {
  readonly expectedRevision: string;
  readonly actualRevision: string;

  constructor(expectedRevision: string, actualRevision: string) {
    super('HUD 配置已在另一页面更新');
    this.name = 'HudConfigEditorConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class HudConfigCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HudConfigCommandError';
  }
}

export class HudConfigPersistenceError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('HUD 配置持久化失败');
    this.name = 'HudConfigPersistenceError';
    this.cause = cause;
  }
}

export interface HudConfigState {
  readonly document: HudConfigDocument;
  readonly resolved: HudResolvedPreset;
  readonly etag: string;
  readonly activeRevision: string;
  readonly editorEtag: string;
  readonly editorRevision: string;
  readonly activationStale: boolean;
  readonly persistenceError: string | null;
}

export interface HudConfigCommandResult {
  readonly kind: 'save-resource' | 'save-as' | 'activate-preset';
  readonly resource?: HudResourceKind;
  readonly resourceId?: string;
  readonly sourceId?: string;
}

export interface HudConfigMutationState extends HudConfigState {
  readonly command: HudConfigCommandResult;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function etagFor(value: unknown): string {
  return `"${hashCanonical(value)}"`;
}

function resourceList(document: HudConfigDocument, kind: HudResourceKind): HudResource[] {
  if (kind === 'preset') return document.customPresets;
  if (kind === 'layout') return document.customLayouts;
  return document.customThemes;
}

function withResourceList(
  document: HudConfigDocument,
  kind: HudResourceKind,
  resources: HudResource[],
): HudConfigDocument {
  if (kind === 'preset') return { ...document, customPresets: resources as HudPreset[] };
  if (kind === 'layout') return { ...document, customLayouts: resources as HudLayout[] };
  return { ...document, customThemes: resources as HudTheme[] };
}

function parseResource(kind: HudResourceKind, value: unknown): HudResource {
  const parsed =
    kind === 'preset'
      ? parseHudPreset(value)
      : kind === 'layout'
        ? parseHudLayout(value)
        : hudThemeSchema.parse(value);
  return { ...parsed, name: parsed.name.trim() };
}

function savedResolvedPreset(document: HudConfigDocument): HudResolvedPreset {
  if (document.activePreset.kind === 'builtin')
    return getBuiltinResolvedPreset(document.activePreset.sourceId);
  const preset = document.customPresets.find((item) => item.id === document.activePreset.sourceId);
  if (preset === undefined) throw new Error('activePreset 引用的自定义预设不存在');
  const layout = [...getBuiltinLayouts(), ...document.customLayouts].find(
    (item) => item.id === preset.layoutId,
  );
  const theme = [...getBuiltinThemes(), ...document.customThemes].find(
    (item) => item.id === preset.themeId,
  );
  if (layout === undefined || theme === undefined) throw new Error('预设引用的资源不存在');
  return resolveHudPreset(preset, layout, theme);
}

function createState(document: HudConfigDocument, persistenceError: string | null): HudConfigState {
  const resolved = resolveActiveHudPreset(document);
  const saved = savedResolvedPreset(document);
  const activationStale = canonicalJson(saved) !== canonicalJson(resolved);
  const activeRevision = hashCanonical(resolved);
  const editorRevision = hashCanonical({ document, activationStale });
  return {
    document: clone(document),
    resolved: clone(resolved),
    etag: etagFor(resolved),
    activeRevision,
    editorEtag: etagFor({ document, activationStale }),
    editorRevision,
    activationStale,
    persistenceError,
  };
}

export class HudConfigStore {
  private readonly filePath: string | undefined;
  private readonly onDiagnostic: (code: string) => void;
  private readonly commits = new SerialCommitQueue();
  private document = createDefaultHudConfigDocument();
  private loaded = false;
  private persistenceError: string | null = null;

  constructor(options: HudConfigStoreOptions = {}) {
    this.filePath = options.filePath;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  async load(): Promise<void> {
    if (this.filePath === undefined) {
      this.loaded = true;
      return;
    }
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.document = parseHudConfigDocument(JSON.parse(raw) as unknown);
      this.persistenceError = null;
      this.loaded = true;
    } catch (error: unknown) {
      this.onDiagnostic(isMissingFile(error) ? 'hud_config_missing' : 'hud_config_invalid');
      this.loaded = true;
      // A running Companion keeps its last-known-valid document. On first boot
      // that document is the current built-in default; the malformed file is
      // deliberately left untouched for operator recovery.
    }
  }

  getState(): HudConfigState {
    return createState(this.document, this.persistenceError);
  }

  async saveResource(
    kind: HudResourceKind,
    value: unknown,
    expectedEditorRevision?: string,
  ): Promise<HudConfigMutationState> {
    let parsed: HudResource;
    try {
      parsed = parseResource(kind, value);
    } catch (error: unknown) {
      throw new HudConfigCommandError(error instanceof Error ? error.message : 'HUD 资源无效');
    }
    if (parsed.id.startsWith('builtin:'))
      throw new HudConfigCommandError('内置 HUD 资源只读，请使用另存为');
    return this.commit(
      () => {
        const resources = resourceList(this.document, kind);
        if (!resources.some((item) => item.id === parsed.id)) {
          throw new Error('只能保存已经存在的自定义 HUD 资源');
        }
        return withResourceList(
          this.document,
          kind,
          resources.map((item) => (item.id === parsed.id ? parsed : item)),
        );
      },
      { kind: 'save-resource', resource: kind, resourceId: parsed.id },
      expectedEditorRevision,
    );
  }

  async saveAs(
    kind: HudResourceKind,
    value: unknown,
    expectedEditorRevision?: string,
  ): Promise<HudConfigMutationState> {
    let parsed: HudResource;
    try {
      parsed = parseResource(kind, value);
    } catch (error: unknown) {
      throw new HudConfigCommandError(error instanceof Error ? error.message : 'HUD 资源无效');
    }
    const resource = { ...parsed, id: randomUUID(), name: parsed.name.trim() } as HudResource;
    return this.commit(
      () => withResourceList(this.document, kind, [...resourceList(this.document, kind), resource]),
      { kind: 'save-as', resource: kind, resourceId: resource.id },
      expectedEditorRevision,
    );
  }

  async activatePreset(
    sourceId: string,
    expectedEditorRevision?: string,
  ): Promise<HudConfigMutationState> {
    return this.commit(
      () => {
        if (BUILTIN_PRESET_IDS.includes(sourceId as (typeof BUILTIN_PRESET_IDS)[number])) {
          return {
            ...this.document,
            activePreset: {
              kind: 'builtin',
              sourceId: sourceId as (typeof BUILTIN_PRESET_IDS)[number],
            },
          };
        }
        const preset = this.document.customPresets.find((item) => item.id === sourceId);
        if (preset === undefined) throw new Error(`找不到要启用的 HUD 预设：${sourceId}`);
        const layout = [...getBuiltinLayouts(), ...this.document.customLayouts].find(
          (item) => item.id === preset.layoutId,
        );
        const theme = [...getBuiltinThemes(), ...this.document.customThemes].find(
          (item) => item.id === preset.themeId,
        );
        if (layout === undefined || theme === undefined) throw new Error('预设引用的资源不存在');
        const snapshot = resolveHudPreset(preset, layout, theme);
        return {
          ...this.document,
          activePreset: { kind: 'custom', sourceId: preset.id, snapshot },
        };
      },
      { kind: 'activate-preset', sourceId },
      expectedEditorRevision,
    );
  }

  private async commit(
    next: HudConfigDocument | (() => HudConfigDocument),
    command: HudConfigCommandResult,
    expectedEditorRevision?: string,
  ): Promise<HudConfigMutationState> {
    return this.commits.run(async () => {
      if (expectedEditorRevision !== undefined) {
        const actualRevision = createState(this.document, this.persistenceError).editorRevision;
        if (actualRevision !== expectedEditorRevision) {
          throw new HudConfigEditorConflictError(expectedEditorRevision, actualRevision);
        }
      }
      let candidate: HudConfigDocument;
      try {
        candidate = parseHudConfigDocument(typeof next === 'function' ? next() : next);
      } catch (error: unknown) {
        throw new HudConfigCommandError(error instanceof Error ? error.message : 'HUD 配置无效');
      }
      try {
        if (this.filePath !== undefined) {
          const committed = await replaceDurableJson(this.filePath, candidate);
          if (!committed) throw new Error('HUD 配置提交已取消');
        }
        this.document = candidate;
        this.persistenceError = null;
      } catch (error: unknown) {
        this.persistenceError = error instanceof Error ? error.message : String(error);
        this.onDiagnostic('hud_config_persist_failed');
        throw new HudConfigPersistenceError(error);
      }
      return { ...this.getState(), command };
    });
  }

  async flush(): Promise<void> {
    await this.commits.flush();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}
