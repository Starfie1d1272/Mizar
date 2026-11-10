// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { parseMatchDocumentV1, type MatchDocumentV1 } from '@mizar/protocol/context';
import {
  LocalTournamentEditor,
  type LocalTournamentView,
} from '../src/workspace/LocalTournamentEditor';

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function editor(scope: 'match' | 'candidate' = 'match') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  // Synthetic local match: only metadata and revision conflicts are under test.
  let selected = parseMatchDocumentV1({
    schemaVersion: 'mizar.match-document.v1',
    matchId: 'match-1',
    competition: null,
    status: 'scheduled',
    format: 'bo3',
    stage: null,
    stageLabel: '小组赛',
    round: null,
    roundLabel: null,
    entryRound: null,
    matchLabel: null,
    stakesLabel: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    scoreA: null,
    scoreB: null,
    isForfeit: false,
    entrants: {
      a: { entryId: 'a', name: '甲队', logoUrl: null, rosterId: null, players: [] },
      b: { entryId: 'b', name: '乙队', logoUrl: null, rosterId: null, players: [] },
    },
    mapPool: [],
    maps: [],
    veto: [],
    commentators: [],
  });
  let view: LocalTournamentView = {
    teams: [],
    events: [],
    matches: [selected],
    activeLocalMatchId: scope === 'match' ? selected.matchId : null,
    selectedMatchId: selected.matchId,
    contextRevision: 'revision-1',
    neighborhood: { previous: null, next: null },
  };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const refresh = vi.fn(async () => {});
  const onDirtyChange = vi.fn();
  const errors: unknown[] = [];
  const render = async () => {
    await act(async () =>
      root.render(
        <LocalTournamentEditor
          document={selected}
          view={view}
          scope={scope}
          refresh={refresh}
          action={async (run) => {
            try {
              await run();
            } catch (error) {
              errors.push(error);
            }
          }}
          onDirtyChange={onDirtyChange}
        />,
      ),
    );
  };
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
  const stage = () =>
    [...host.querySelectorAll('label')]
      .find((item) => item.textContent?.includes('阶段名称'))!
      .querySelector('input')!;
  await render();
  return {
    host,
    fetcher,
    refresh,
    errors,
    onDirtyChange,
    button,
    stage,
    get selected() {
      return selected;
    },
    async poll(next: MatchDocumentV1, revision = 'revision-2') {
      selected = next;
      view = {
        ...view,
        matches: [next],
        contextRevision: revision,
        activeLocalMatchId: scope === 'match' ? next.matchId : null,
      };
      await render();
    },
    async edit(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          stage(),
          value,
        );
        stage().dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    async click(label: string) {
      await act(async () => button(label).click());
    },
  };
}

it('retains a dirty current-match baseline after another window changes the team', async () => {
  const ui = await editor();
  await ui.edit('决赛');
  const newer = structuredClone(ui.selected);
  newer.entrants.a.name = '另一窗口的队名';
  await ui.poll(newer);
  expect(ui.stage().value).toBe('决赛');
  expect(ui.button('保存比赛资料').disabled).toBe(true);
  expect(ui.host.textContent).toContain('草稿保留，请取消后重新核对');
  await ui.click('保存比赛资料');
  expect(ui.fetcher).not.toHaveBeenCalled();
  await ui.click('取消编辑');
  expect(ui.stage().value).toBe(newer.stageLabel);
  expect(ui.button('保存比赛资料').disabled).toBe(false);
  await ui.edit('新决赛');
  await ui.click('保存比赛资料');
  await ui.click('确认继续');
  const payload = JSON.parse(ui.fetcher.mock.calls[0]![1]!.body as string);
  expect(payload.expectedContextRevision).toBe('revision-2');
  expect(payload.document.entrants.a.name).toBe('另一窗口的队名');
});

it('does not replace a dirty revision on revision-only polling and preserves it during confirmation', async () => {
  const ui = await editor();
  await ui.edit('决赛');
  await ui.click('保存比赛资料');
  await ui.poll(structuredClone(ui.selected));
  expect(ui.button('保存比赛资料').disabled).toBe(true);
  ui.fetcher.mockImplementationOnce(async () => new Response(null, { status: 409 }));
  await ui.click('确认继续');
  const payload = JSON.parse(ui.fetcher.mock.calls[0]![1]!.body as string);
  expect(payload.expectedContextRevision).toBe('revision-1');
  expect(ui.errors).toHaveLength(1);
  expect(ui.stage().value).toBe('决赛');
  expect(ui.onDirtyChange).toHaveBeenLastCalledWith(true);
});

it('follows clean updates, rebases accepted saves, and protects a dirty draft across match switches', async () => {
  const ui = await editor();
  await ui.poll({ ...ui.selected, stageLabel: '半决赛' });
  expect(ui.stage().value).toBe('半决赛');
  await ui.edit('决赛');
  await ui.click('保存比赛资料');
  await ui.click('取消');
  expect(ui.fetcher).not.toHaveBeenCalled();
  expect(ui.stage().value).toBe('决赛');
  await ui.click('保存比赛资料');
  await ui.click('确认继续');
  await ui.poll({ ...ui.selected, stageLabel: '决赛' }, 'revision-3');
  expect(ui.onDirtyChange).toHaveBeenLastCalledWith(false);
  await ui.click('保存比赛资料');
  await ui.click('确认继续');
  expect(JSON.parse(ui.fetcher.mock.calls[1]![1]!.body as string).expectedContextRevision).toBe(
    'revision-3',
  );
  await ui.edit('旧场草稿');
  await ui.poll({ ...ui.selected, matchId: 'another-match', stageLabel: '新场' }, 'revision-4');
  expect(ui.stage().value).toBe('旧场草稿');
  expect(ui.button('保存比赛资料').disabled).toBe(true);
  await ui.click('取消编辑');
  expect(ui.stage().value).toBe('新场');
  expect(ui.button('保存比赛资料').disabled).toBe(false);
});

it('keeps candidate expectedDocument protection independent of the active context revision', async () => {
  const ui = await editor('candidate');
  const baseline = structuredClone(ui.selected);
  await ui.edit('候选阶段');
  await ui.poll(structuredClone(ui.selected));
  expect(ui.button('保存比赛资料').disabled).toBe(false);
  await ui.click('保存比赛资料');
  await ui.click('确认继续');
  const payload = JSON.parse(ui.fetcher.mock.calls[0]![1]!.body as string);
  expect(payload.expectedDocument).toEqual(baseline);
  expect(payload).not.toHaveProperty('expectedContextRevision');
  await ui.poll({ ...ui.selected, roundLabel: '另一窗口轮次' });
  expect(ui.button('保存比赛资料').disabled).toBe(true);
  expect(ui.stage().value).toBe('候选阶段');
});
