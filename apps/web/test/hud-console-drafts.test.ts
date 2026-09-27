import { describe, expect, it } from 'vitest';

import {
  createDefaultHudConfigDocument,
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinTheme,
} from '@mizar/hud-config';

import {
  mergeHudEditorDocument,
  type HudDraftConflicts,
  type HudDraftIds,
  type HudDrafts,
} from '../src/operator/hud-console-drafts';

function fixtureDocument() {
  return {
    ...createDefaultHudConfigDocument(),
    customThemes: [
      {
        ...getBuiltinTheme(),
        id: 'theme-a',
        name: '外观 A',
      },
    ],
  };
}

function currentState(document: ReturnType<typeof fixtureDocument>) {
  const ids: HudDraftIds = {
    preset: getBuiltinPreset().id,
    layout: getBuiltinLayout().id,
    theme: 'theme-a',
  };
  const drafts: HudDrafts = {
    preset: getBuiltinPreset(),
    layout: getBuiltinLayout(),
    theme: document.customThemes[0]!,
  };
  const conflicts: HudDraftConflicts = { preset: false, layout: false, theme: false };
  return { ids, drafts, conflicts, baseRevisions: { preset: 'r1', layout: 'r1', theme: 'r1' } };
}

describe('HUD console authoritative draft merge', () => {
  it('updates a clean draft from another page and remains clean', () => {
    const previous = fixtureDocument();
    const next = {
      ...previous,
      customThemes: [{ ...previous.customThemes[0]!, brandColor: '#aa66ff' }],
    };
    const state = currentState(previous);
    const merged = mergeHudEditorDocument({
      currentIds: state.ids,
      currentDrafts: state.drafts,
      currentConflicts: state.conflicts,
      baseRevisions: state.baseRevisions,
      previousDocument: previous,
      nextDocument: next,
      nextRevision: 'r2',
      committed: null,
    });

    expect(merged.drafts.theme.brandColor).toBe('#aa66ff');
    expect(merged.conflicts.theme).toBe(false);
    expect(merged.baseRevisions.theme).toBe('r2');
  });

  it('retains a dirty draft when another page changes an unrelated resource', () => {
    const previous = fixtureDocument();
    const next = {
      ...previous,
      customThemes: [{ ...previous.customThemes[0]!, brandColor: '#aa66ff' }],
    };
    const state = currentState(previous);
    state.drafts.theme = { ...state.drafts.theme, name: '本地草稿' };
    const merged = mergeHudEditorDocument({
      currentIds: state.ids,
      currentDrafts: state.drafts,
      currentConflicts: state.conflicts,
      baseRevisions: state.baseRevisions,
      previousDocument: previous,
      nextDocument: next,
      nextRevision: 'r2',
      committed: null,
    });

    expect(merged.drafts.theme.name).toBe('本地草稿');
    expect(merged.conflicts.theme).toBe(true);
    expect(merged.baseRevisions.theme).toBe('r1');
  });

  it('advances the base revision when a dirty draft resource is unchanged remotely', () => {
    const previous = fixtureDocument();
    const state = currentState(previous);
    state.drafts.theme = { ...state.drafts.theme, name: '本地草稿' };
    const merged = mergeHudEditorDocument({
      currentIds: state.ids,
      currentDrafts: state.drafts,
      currentConflicts: state.conflicts,
      baseRevisions: state.baseRevisions,
      previousDocument: previous,
      nextDocument: { ...previous, customPresets: [{ ...getBuiltinPreset(), id: 'preset-b' }] },
      nextRevision: 'r2',
      committed: null,
    });

    expect(merged.drafts.theme.name).toBe('本地草稿');
    expect(merged.conflicts.theme).toBe(false);
    expect(merged.baseRevisions.theme).toBe('r2');
  });
});
