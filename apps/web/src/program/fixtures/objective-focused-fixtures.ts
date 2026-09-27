import {
  programSnapshotSchema,
  type ProgramPayload,
  type ProgramSnapshot,
} from '@mizar/protocol/program';
import { realProgramFixtures } from './real-program-fixtures.js';
import { derivePresentationStressFixture } from './presentation-stress.js';

type Player = ProgramPayload['players'][number];
const live = realProgramFixtures['real-live-rich'].snapshot;
const planted = realProgramFixtures['real-planted'].snapshot;
const defusing = realProgramFixtures['real-defusing'].snapshot;
const focused = live.payload.players.find(
  (p) => p.sourcePlayerId === live.payload.observedPlayerSourceId,
)!;
// Deterministic test media, deliberately not a real person's portrait.
export const FOCUSED_TEST_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="#315a72"/><path d="M0 65L35 20L88 65V88H0Z" fill="#8cb9ce"/><circle cx="65" cy="22" r="9" fill="#d9e9ef"/></svg>')}`;
function edge(base: ProgramSnapshot, patch: Partial<ProgramPayload>): ProgramSnapshot {
  return programSnapshotSchema.parse({ ...base, payload: { ...base.payload, ...patch } });
}
function playerEdge(patch: Partial<Player>): ProgramSnapshot {
  return edge(live, {
    players: live.payload.players.map((p) =>
      p.sourcePlayerId === focused.sourcePlayerId ? { ...p, ...patch } : p,
    ),
  });
}
const action = defusing.payload.bomb!.action!;
const active = focused.weapons.find((w) => w.state === 'active')!;
const missingAmmo = playerEdge({
  completedAdr: null,
  weapons: focused.weapons.map((w) =>
    w.state === 'active' ? { ...w, ammoClipMax: null, ammoReserve: null } : w,
  ),
});
export const objectiveFocusedFixtures = {
  'focused-avatar': derivePresentationStressFixture(live, {
    playerAvatars: { [focused.sourcePlayerId]: FOCUSED_TEST_AVATAR },
  }),
  'focused-long-name': derivePresentationStressFixture(live, {
    playerNames: { [focused.sourcePlayerId]: 'Very Long Observed Player Display Name' },
    teamALogoUrl: FOCUSED_TEST_AVATAR,
  }),
  'focused-low-health-edge': playerEdge({ state: { ...focused.state!, health: 20 } }),
  'focused-shells-edge': playerEdge({
    weapons: [{ ...active, name: 'weapon_nova', ammoClip: 5, ammoClipMax: 8, ammoReserve: 12 }],
  }),
  'focused-grenade-edge': playerEdge({
    weapons: [
      { ...active, name: 'weapon_flashbang', ammoClip: null, ammoClipMax: null, ammoReserve: 2 },
    ],
  }),
  'focused-unavailable-edge': missingAmmo,
  'objective-live-4v5-edge': edge(live, {
    players: live.payload.players.map((p, i) =>
      i === 0 ? { ...p, lifeState: 'dead', state: { ...p.state!, health: 0 } } : p,
    ),
  }),
  'objective-late-plant-edge': edge(realProgramFixtures['real-planting'].snapshot, {
    bomb: {
      ...realProgramFixtures['real-planting'].snapshot.payload.bomb!,
      action: {
        ...realProgramFixtures['real-planting'].snapshot.payload.bomb!.action!,
        durationSeconds: null,
      },
    },
  }),
  'objective-late-planted-edge': edge(planted, {
    bomb: {
      ...planted.payload.bomb!,
      explosion: { ...planted.payload.bomb!.explosion!, durationSeconds: null },
    },
  }),
  'objective-unavailable-edge': edge(planted, {
    bomb: {
      ...planted.payload.bomb!,
      explosion: { remainingSeconds: null, durationSeconds: null },
    },
  }),
  'objective-no-kit-edge': edge(defusing, {
    bomb: {
      ...defusing.payload.bomb!,
      action: { ...action, kind: 'defuse', durationSeconds: 10, hasDefuseKit: false },
    },
  }),
  'objective-dual-progress-edge': edge(defusing, {
    bomb: {
      ...defusing.payload.bomb!,
      explosion: { remainingSeconds: 8, durationSeconds: 39.8 },
      action: { ...action, remainingSeconds: 2 },
    },
  }),
  'objective-paused-edge': edge(planted, { clock: { phase: 'paused', endsInSeconds: null } }),
  'objective-long-defuser': derivePresentationStressFixture(defusing, {
    playerNames: { [action.sourcePlayerId!]: 'Very Long Defuser Display Name' },
  }),
  'objective-stale-edge': edge(planted, {
    status: { ...planted.payload.status, telemetry: 'stale' },
  }),
};
export const OBJECTIVE_FOCUSED_PROVENANCE = Object.fromEntries(
  Object.keys(objectiveFocusedFixtures).map((id) => [
    id,
    {
      kind: id.endsWith('-edge')
        ? ('synthetic-edge' as const)
        : ('synthetic-presentation' as const),
      reason: id.endsWith('-edge')
        ? `显式边界测试 ${id}：基于真实快照覆盖缺失/中断/冲突或现有采集未包含的装备与生命边界；不作为真实 gameplay evidence。`
        : '真实 gameplay 保持不变，仅覆盖确定性头像、队伍 logo 或长显示名称。',
    },
  ]),
) as Record<
  keyof typeof objectiveFocusedFixtures,
  { readonly kind: 'synthetic-edge' | 'synthetic-presentation'; readonly reason: string }
>;
