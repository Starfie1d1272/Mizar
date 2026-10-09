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
  it.each([
    { dirty: false, remoteTheme: true, conflict: false, revision: 'r2' },
    { dirty: true, remoteTheme: true, conflict: true, revision: 'r1' },
    { dirty: true, remoteTheme: false, conflict: false, revision: 'r2' },
  ])(
    'merges without losing edits: $dirty dirty, $remoteTheme remote theme change',
    ({ dirty, remoteTheme, conflict, revision }) => {
      const previous = fixtureDocument();
      const state = currentState(previous);
      if (dirty) state.drafts.theme = { ...state.drafts.theme, name: '本地草稿' };
      const merged = mergeHudEditorDocument({
        currentIds: state.ids,
        currentDrafts: state.drafts,
        currentConflicts: state.conflicts,
        baseRevisions: state.baseRevisions,
        previousDocument: previous,
        nextDocument: remoteTheme
          ? { ...previous, customThemes: [{ ...previous.customThemes[0]!, brandColor: '#aa66ff' }] }
          : { ...previous, customPresets: [{ ...getBuiltinPreset(), id: 'preset-b' }] },
        nextRevision: 'r2',
        committed: null,
      });
      expect(merged.drafts.theme).toMatchObject(
        dirty ? { name: '本地草稿' } : { brandColor: '#aa66ff' },
      );
      expect(merged.conflicts.theme).toBe(conflict);
      expect(merged.baseRevisions.theme).toBe(revision);
    },
  );
});
