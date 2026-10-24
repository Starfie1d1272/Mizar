import { useEffect, useState } from 'react';

import type { ProgramSnapshot } from '@mizar/protocol/program';

import { ProgramCanvas } from '../ProgramCanvas';
import { GameplayHud } from '../GameplayHud';
import { getProgramFixture, getProgramFixtureProvenance } from '../fixtures';
import { ProgramFoundationProbe } from './ProgramFoundationProbe';
import { getBuiltinResolvedPreset } from '@mizar/hud-config';

import { radarVisualFixture } from '../fixtures/radar-fixtures';
import { getDefaultHudCompositeFixture } from '../fixtures/default-hud-composite-fixtures';

export function ProgramVisualFixturePage({ fixtureId }: { readonly fixtureId: string }) {
  const compositeFixture = getDefaultHudCompositeFixture(fixtureId);
  const isIntegrated = fixtureId === 'program-radar-integrated';
  const chatStyle = fixtureId.startsWith('all-chat-')
    ? fixtureId.slice('all-chat-'.length).replace(/-(freezetime|timeout-ct|timeout-t|paused)$/, '')
    : null;
  const sourceSnapshot =
    compositeFixture?.snapshot ??
    (isIntegrated || chatStyle
      ? getProgramFixture(
          chatStyle && fixtureId.endsWith('-freezetime')
            ? 'player-rails-freezetime'
            : 'live-canonical',
        )
      : getProgramFixture(fixtureId));
  const snapshot =
    sourceSnapshot && chatStyle
      ? {
          ...sourceSnapshot,
          payload: {
            ...sourceSnapshot.payload,
            ...(fixtureId.endsWith('-timeout-ct') ||
            fixtureId.endsWith('-timeout-t') ||
            fixtureId.endsWith('-paused')
              ? {
                  clock: {
                    ...sourceSnapshot.payload.clock!,
                    phase: fixtureId.endsWith('-timeout-ct')
                      ? ('timeout_ct' as const)
                      : fixtureId.endsWith('-timeout-t')
                        ? ('timeout_t' as const)
                        : ('paused' as const),
                  },
                }
              : {}),
            allChat: [
              {
                id: 'public-synthetic-3',
                sender: '观众样例',
                text: '技术暂停和战术暂停的三条最长消息，检查名单和历史避让。'.repeat(4),
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
              {
                id: 'public-synthetic-1',
                sender: 'm0NESY',
                text: '这是一条最长公共聊天样例，用于检查暂停卡片上方的换行与对齐。'.repeat(4),
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
              {
                id: 'public-synthetic-2',
                sender: '很长的测试选手名称 Player',
                text: '这是一条用于检查换行与可读性的公共聊天。Good luck, have fun!'.repeat(3),
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            ],
          },
        }
      : sourceSnapshot;
  if (snapshot === null) {
    return <ProgramVisualFixtureNotFound fixtureId={fixtureId} />;
  }

  const basePreset = getBuiltinResolvedPreset(
    chatStyle && chatStyle !== 'current' ? `builtin:${chatStyle}-preset` : undefined,
  );
  const showRadar = compositeFixture !== null || isIntegrated;
  const resolvedPreset = showRadar
    ? basePreset
    : {
        ...basePreset,
        layout: {
          ...basePreset.layout,
          widgets: {
            ...basePreset.layout.widgets,
            radar: { ...basePreset.layout.widgets.radar, visible: false },
          },
        },
      };

  const radarSnapshot =
    compositeFixture?.radarSnapshot ??
    (isIntegrated ? radarVisualFixture('focused').snapshot : undefined);

  return (
    <ProgramCanvas>
      <div
        style={{ display: 'contents' }}
        data-program-fixture-kind={
          (chatStyle ? 'synthetic' : compositeFixture?.provenance) ??
          (isIntegrated ? 'real-derived' : getProgramFixtureProvenance(fixtureId)?.kind)
        }
        data-program-fixture-id={fixtureId}
      >
        {fixtureId === 'player-rails-carryover' ? (
          <CarryoverVisualFixture resolvedPreset={resolvedPreset} snapshot={snapshot} />
        ) : (
          <>
            <GameplayHud
              gg={fixtureId === 'gameplay-map-ended-gg'}
              radarSnapshot={radarSnapshot}
              resolvedPreset={resolvedPreset}
              snapshot={snapshot}
            />
            {compositeFixture === null && !chatStyle ? (
              <ProgramFoundationProbe fixtureId={fixtureId} snapshot={snapshot} />
            ) : null}
          </>
        )}
      </div>
    </ProgramCanvas>
  );
}

function CarryoverVisualFixture({
  snapshot,
  resolvedPreset,
}: {
  readonly snapshot: ProgramSnapshot;
  readonly resolvedPreset: ReturnType<typeof getBuiltinResolvedPreset>;
}) {
  const carryoverSource = getProgramFixture('player-rails-freezetime');
  const [displayedSnapshot, setDisplayedSnapshot] = useState<ProgramSnapshot>(
    carryoverSource ?? snapshot,
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDisplayedSnapshot(snapshot), 50);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  return (
    <>
      <GameplayHud resolvedPreset={resolvedPreset} snapshot={displayedSnapshot} />
      <ProgramFoundationProbe fixtureId="player-rails-carryover" snapshot={displayedSnapshot} />
    </>
  );
}

export function ProgramVisualFixtureNotFound({ fixtureId }: { readonly fixtureId: string | null }) {
  return (
    <main className="program-visual-not-found" data-visual-fixture-state="not-found">
      <section className="program-visual-not-found__panel">
        <h1>视觉测试场景不可用</h1>
        <p>
          {fixtureId === null
            ? '视觉测试路由需要指定场景 ID，且必须启用开发环境测试开关。'
            : `未注册 ID 为“${fixtureId}”的节目状态测试场景。`}
        </p>
      </section>
    </main>
  );
}
