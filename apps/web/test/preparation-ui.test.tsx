// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';

const mockReads: Record<string, unknown> = {};
const mockCommand = vi.fn().mockResolvedValue({});

vi.mock('../src/preparation/client', () => ({
  useLocalRead: (endpoint: string | null) => (endpoint ? mockReads[endpoint] ?? null : null),
  command: (path: string, body?: unknown) => mockCommand(path, body),
  openTool: vi.fn(),
  productionAction: vi.fn(),
}));

vi.mock('../src/realtime/hud-config-client', () => ({
  useHudConfigClient: () => ({ current: {} }),
}));

vi.mock('../src/workspace/client', () => ({
  useProgramScenes: () => ({ available: [], blocked: {} }),
}));

vi.mock('../src/preparation/tournament', () => ({
  useLocalTournament: () => ({ local: false, view: null, refresh: vi.fn() }),
}));

vi.mock('../src/operator/RivalHubPreparationPanel', () => ({
  RivalHubPreparationPanel: () => null,
}));

import { PreparationPage } from '../src/preparation/PreparationPage';

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockCommand.mockClear();
  for (const key of Object.keys(mockReads)) delete mockReads[key];
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  window.history.replaceState({}, '', '/');
});

const sampleMatch = {
  matchId: 'match-1',
  competition: { competitionId: 'c1', name: '2026 NJU Rivals', logoUrl: null, themeColor: null },
  format: 'bo3',
  stageLabel: '总决赛',
  roundLabel: null,
  matchLabel: '第一场',
  scheduledAt: '2026-09-28T12:00:00.000Z',
  entrants: {
    a: {
      entryId: 'e-1',
      name: 'Team D\'avenir',
      logoUrl: null,
      rosterId: null,
      players: [
        { playerId: 'p1', steam64: null, displayName: 'A1', avatarUrl: null, isStarter: true },
        { playerId: 'p2', steam64: null, displayName: 'A2', avatarUrl: null, isStarter: true },
        { playerId: 'p3', steam64: null, displayName: 'A3', avatarUrl: null, isStarter: true },
        { playerId: 'p4', steam64: null, displayName: 'A4', avatarUrl: null, isStarter: true },
        { playerId: 'p5', steam64: null, displayName: 'A5', avatarUrl: null, isStarter: true },
        { playerId: 'p6', steam64: null, displayName: 'A6', avatarUrl: null, isStarter: false },
      ],
    },
    b: {
      entryId: 'e-2',
      name: '暴躁南梁',
      logoUrl: null,
      rosterId: null,
      players: [
        { playerId: 'p7', steam64: null, displayName: 'B1', avatarUrl: null, isStarter: true },
        { playerId: 'p8', steam64: null, displayName: 'B2', avatarUrl: null, isStarter: true },
        { playerId: 'p9', steam64: null, displayName: 'B3', avatarUrl: null, isStarter: true },
        { playerId: 'p10', steam64: null, displayName: 'B4', avatarUrl: null, isStarter: true },
        { playerId: 'p11', steam64: null, displayName: 'B5', avatarUrl: null, isStarter: true },
      ],
    },
  },
  veto: [
    { stepOrder: 1, actionType: 'ban', mapName: 'de_dust2', entryId: 'e-1', side: null },
    { stepOrder: 2, actionType: 'ban', mapName: 'de_mirage', entryId: 'e-2', side: null },
  ],
  maps: [
    { mapId: 'm1', mapOrder: 1, mapName: 'de_ancient', pickedByEntryId: 'e-1', teamAStartSide: null, scoreA: null, scoreB: null, completedAt: null },
    { mapId: 'm2', mapOrder: 2, mapName: 'de_nuke', pickedByEntryId: 'e-2', teamAStartSide: null, scoreA: null, scoreB: null, completedAt: null },
  ],
};

const sampleEnvelope = {
  source: 'fixture',
  freshness: 'fresh',
  document: sampleMatch as unknown as MatchDocumentV1,
  staleAfterMs: 30000,
} as unknown as ContextEnvelope<MatchDocumentV1>;

describe('PreparationPage: readiness and sample workflow', () => {
  it('displays factual counts (BP steps, starters, maps) and not inferred readiness labels', async () => {
    mockReads['/local/v1/match-document'] = sampleEnvelope;
    mockReads['/local/v1/rivals-rehearsal'] = {
      loaded: true,
      focusMatchId: 'match-1',
      selectedMatchId: 'match-1',
      stageIndex: 0,
      stages: [
        { label: '赛前等待', scene: 'waiting' },
        { label: '对阵', scene: 'matchup' },
      ],
      provenance: null,
    };
    mockReads['/local/v1/rivals-rehearsal/schedule'] = {
      competition: { name: '2026 NJU Rivals' },
      matches: [
        {
          matchId: 'match-1',
          scheduledAt: '2026-09-28T12:00:00.000Z',
          entrantA: { name: 'Team D\'avenir' },
          entrantB: { name: '暴躁南梁' },
          format: 'bo3',
          stageLabel: '总决赛',
        },
        {
          matchId: 'match-0',
          scheduledAt: '2026-09-28T10:00:00.000Z',
          entrantA: { name: 'Team Alpha' },
          entrantB: { name: 'Team Beta' },
          format: 'bo3',
          stageLabel: '半决赛',
        },
      ],
    };

    await act(async () => {
      root!.render(<PreparationPage />);
    });

    const summary = container.querySelector('.preparation-match__summary');
    expect(summary).not.toBeNull();
    // BP shows exact step count: "2 步"
    expect(summary?.textContent).toContain('BP · 2 步');
    // Does NOT say "BP 已就绪"
    expect(summary?.textContent).not.toContain('BP 已就绪');
    // Starters show exact count "5 / 5 人"
    expect(summary?.textContent).toContain('名单 · 首发 5 / 5 人');
    // Does NOT say "双方首发已就绪"
    expect(summary?.textContent).not.toContain('双方首发已就绪');
    // Confirmed maps
    expect(summary?.textContent).toContain('地图 · 已确定 2 图（ancient · nuke）');

    // Wording uses "Rivals 示例阶段推进" (no "演练")
    expect(container.textContent).toContain('Rivals 示例阶段推进');
    expect(container.textContent).not.toContain('演练');

    // Schedule selector allows switching sample matches
    const select = container.querySelector('#rehearsal-match-select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options.length).toBe(2);

    await act(async () => {
      select.value = 'match-0';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mockCommand).toHaveBeenCalledWith('/operator/rivals-rehearsal/select', {
      matchId: 'match-0',
    });
  });
});
