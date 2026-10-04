import {
  canonicalJson,
  getBuiltinLayout,
  getBuiltinPresets,
  getBuiltinThemes,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudTheme,
} from '@mizar/hud-config';

import type { HudResource, HudWorkspace } from './hud-console-state';

export interface HudDraftIds {
  preset: string;
  layout: string;
  theme: string;
}

export interface HudDrafts {
  preset: HudPreset;
  layout: HudLayout;
  theme: HudTheme;
}

export type HudDraftBaseRevisions = Record<HudWorkspace, string | null>;
export type HudDraftConflicts = Record<HudWorkspace, boolean>;

export function cloneHudValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resourceList(document: HudConfigDocument, kind: HudWorkspace): HudResource[] {
  if (kind === 'preset') return [...getBuiltinPresets(), ...document.customPresets];
  if (kind === 'layout') return [getBuiltinLayout(), ...document.customLayouts];
  return [...getBuiltinThemes(), ...document.customThemes];
}

export function resourceFor(
  document: HudConfigDocument,
  kind: HudWorkspace,
  id: string,
): HudResource | undefined {
  return resourceList(document, kind).find((resource) => resource.id === id);
}

export function activePresetId(document: HudConfigDocument): string {
  return document.activePreset.sourceId;
}

export function isHudResourceSame(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface MergeHudEditorDocumentInput {
  readonly previousDocument: HudConfigDocument | null;
  readonly nextDocument: HudConfigDocument;
  readonly currentIds: HudDraftIds;
  readonly currentDrafts: HudDrafts;
  readonly currentConflicts: HudDraftConflicts;
  readonly baseRevisions: HudDraftBaseRevisions;
  readonly nextRevision: string;
  readonly committed: { readonly kind: HudWorkspace; readonly resourceId: string } | null;
}

export interface MergeHudEditorDocumentResult {
  readonly ids: HudDraftIds;
  readonly drafts: HudDrafts;
  readonly conflicts: HudDraftConflicts;
  readonly baseRevisions: HudDraftBaseRevisions;
}

/** Merge an authoritative poll without overwriting dirty drafts or hiding conflicts. */
export function mergeHudEditorDocument({
  previousDocument,
  nextDocument,
  currentIds,
  currentDrafts,
  currentConflicts,
  baseRevisions,
  nextRevision,
  committed,
}: MergeHudEditorDocumentInput): MergeHudEditorDocumentResult {
  const nextPresetId = activePresetId(nextDocument);
  const nextPreset = resourceFor(nextDocument, 'preset', nextPresetId) as HudPreset;
  const fallbackIds: HudDraftIds = {
    preset: nextPresetId,
    layout: nextPreset.layoutId,
    theme: nextPreset.themeId,
  };
  const ids = { ...currentIds };
  const drafts: HudDrafts = { ...currentDrafts };
  const mutableDrafts = drafts as unknown as Record<HudWorkspace, HudResource>;
  const conflicts = { ...currentConflicts };
  const nextBaseRevisions = { ...baseRevisions };

  if (previousDocument === null) {
    ids.preset = fallbackIds.preset;
    ids.layout = fallbackIds.layout;
    ids.theme = fallbackIds.theme;
    drafts.preset = cloneHudValue(resourceFor(nextDocument, 'preset', ids.preset) as HudPreset);
    drafts.layout = cloneHudValue(resourceFor(nextDocument, 'layout', ids.layout) as HudLayout);
    drafts.theme = cloneHudValue(resourceFor(nextDocument, 'theme', ids.theme) as HudTheme);
    conflicts.preset = false;
    conflicts.layout = false;
    conflicts.theme = false;
    nextBaseRevisions.preset = nextRevision;
    nextBaseRevisions.layout = nextRevision;
    nextBaseRevisions.theme = nextRevision;
    return { ids, drafts, conflicts, baseRevisions: nextBaseRevisions };
  }

  for (const kind of ['preset', 'layout', 'theme'] as const) {
    const currentId = currentIds[kind];
    const previousResource = resourceFor(previousDocument, kind, currentId);
    const nextResource = resourceFor(nextDocument, kind, currentId);
    const wasDirty =
      previousResource === undefined || !isHudResourceSame(previousResource, currentDrafts[kind]);
    const remoteChanged = !isHudResourceSame(previousResource, nextResource);
    const isCommitted = committed?.kind === kind && committed.resourceId === currentId;

    if (isCommitted && nextResource !== undefined) {
      mutableDrafts[kind] = cloneHudValue(nextResource);
      conflicts[kind] = false;
      nextBaseRevisions[kind] = nextRevision;
      continue;
    }
    if (!wasDirty) {
      const cleanResource = nextResource ?? resourceFor(nextDocument, kind, fallbackIds[kind]);
      if (cleanResource === undefined) continue;
      ids[kind] = cleanResource.id;
      mutableDrafts[kind] = cloneHudValue(cleanResource);
      conflicts[kind] = false;
      nextBaseRevisions[kind] = nextRevision;
      continue;
    }
    if (!remoteChanged) {
      nextBaseRevisions[kind] = nextRevision;
      continue;
    }
    conflicts[kind] = true;
  }

  return { ids, drafts, conflicts, baseRevisions: nextBaseRevisions };
}
