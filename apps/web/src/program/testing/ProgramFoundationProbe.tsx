import type { ProgramSnapshot } from '@mizar/protocol/program';

import { PROGRAM_FIXTURE_LABELS, type ProgramFixtureId } from '../fixtures';

import './ProgramFoundationProbe.css';

const TOKEN_SWATCHES = [
  ['--rh-program-text', '节目文字'],
  ['--rh-program-muted', '次要文字'],
  ['--rh-program-surface', '面板底色'],
  ['--rh-program-surface-strong', '面板强调底色'],
  ['--rh-program-border', '边框'],
  ['--rh-program-ct', 'CT 队伍'],
  ['--rh-program-t', 'T 队伍'],
  ['--rh-program-accent', '重点信息'],
  ['--rh-program-warning', '提醒'],
  ['--rh-program-danger', '危险'],
] as const;

const STATUS_LABELS: Record<string, string> = {
  awaiting: '等待数据',
  fresh: '正常',
  stale: '已过期',
  unbound: '未绑定',
  resolving: '解析中',
  matched: '已匹配',
  degraded: '部分确认',
  mismatch: '不匹配',
};

const CLOCK_LABELS: Record<string, string> = {
  freezetime: '冻结时间',
  live: '进行中',
  bomb: '炸弹阶段',
  defuse: '拆弹阶段',
  over: '回合结束',
  timeout_ct: 'CT 暂停',
  timeout_t: 'T 暂停',
};

function displayValue(value: string | number | null | undefined, emptyValue = '—'): string {
  return value === null || value === undefined || value === '' ? emptyValue : String(value);
}

function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? '未知状态';
}

function clockLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return CLOCK_LABELS[value] ?? '未知阶段';
}

function SampleValue({ value }: { readonly value: string | null | undefined }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <span className="program-foundation-probe__sample-value" data-empty={empty}>
      {displayValue(value, '本场景暂无数据')}
    </span>
  );
}

export function ProgramFoundationProbe({
  fixtureId,
  snapshot,
}: {
  readonly fixtureId: string;
  readonly snapshot: ProgramSnapshot;
}) {
  const { payload } = snapshot;
  const firstPlayer = payload.players[0];

  return (
    <div
      className="program-foundation-probe"
      data-fixture-id={fixtureId}
      data-program-foundation-probe="true"
    >
      <span
        aria-hidden="true"
        className="program-foundation-probe__anchor program-foundation-probe__anchor--top-left"
      />
      <span
        aria-hidden="true"
        className="program-foundation-probe__anchor program-foundation-probe__anchor--top-right"
      />
      <span
        aria-hidden="true"
        className="program-foundation-probe__anchor program-foundation-probe__anchor--bottom-left"
      />
      <span
        aria-hidden="true"
        className="program-foundation-probe__anchor program-foundation-probe__anchor--bottom-right"
      />

      <header className="program-foundation-probe__header">
        <p className="program-foundation-probe__kicker">Mizar / 仅供视觉测试</p>
        <h1>节目画面基础</h1>
        <p>用于固定逻辑画布的投影检查，不属于正式 HUD、雷达或正式节目页面。</p>
      </header>

      <section className="program-foundation-probe__meta" aria-label="节目状态信息">
        <div className="program-foundation-probe__meta-row">
          <span className="program-foundation-probe__meta-label">测试场景</span>
          <span className="program-foundation-probe__meta-value">
            <code>{PROGRAM_FIXTURE_LABELS[fixtureId as ProgramFixtureId] ?? '未知测试场景'}</code>
          </span>
        </div>
        <div className="program-foundation-probe__meta-row">
          <span className="program-foundation-probe__meta-label">画布</span>
          <span className="program-foundation-probe__meta-value">1920 × 1080 逻辑像素</span>
        </div>
        <div className="program-foundation-probe__meta-row">
          <span className="program-foundation-probe__meta-label">状态</span>
          <span className="program-foundation-probe__meta-value">
            {statusLabel(payload.status.telemetry)} / {statusLabel(payload.status.context)} /{' '}
            {statusLabel(payload.status.identity)}
          </span>
        </div>
        <div className="program-foundation-probe__meta-row">
          <span className="program-foundation-probe__meta-label">状态位置</span>
          <span className="program-foundation-probe__meta-value">
            第 {snapshot.cursor.runtimeSeq} 帧 · 第 {snapshot.cursor.mapEpoch} 张地图
          </span>
        </div>
      </section>

      <section className="program-foundation-probe__tokens" aria-label="节目视觉变量">
        <h2>中性视觉变量</h2>
        <div className="program-foundation-probe__token-grid">
          {TOKEN_SWATCHES.map(([tokenName, label]) => (
            <div className="program-foundation-probe__token" key={tokenName}>
              <span
                aria-hidden="true"
                className="program-foundation-probe__token-swatch"
                style={{ backgroundColor: `var(${tokenName})` }}
              />
              <span className="program-foundation-probe__token-name">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="program-foundation-probe__sample" aria-label="节目状态示例">
        <h2>节目状态示例</h2>
        <div className="program-foundation-probe__sample-row">
          <span className="program-foundation-probe__sample-label">赛事</span>
          <SampleValue value={payload.match?.competition.name} />
        </div>
        <div className="program-foundation-probe__sample-row">
          <span className="program-foundation-probe__sample-label">CT / T</span>
          <span className="program-foundation-probe__sample-value">
            {payload.teams.ct.name} <span aria-hidden="true">/</span> {payload.teams.t.name}
          </span>
        </div>
        <div className="program-foundation-probe__sample-row">
          <span className="program-foundation-probe__sample-label">当前选手</span>
          <SampleValue value={firstPlayer?.displayName} />
        </div>
        <div className="program-foundation-probe__sample-row">
          <span className="program-foundation-probe__sample-label">地图 / 时间</span>
          <span className="program-foundation-probe__sample-value">
            {displayValue(payload.map.name)} <span aria-hidden="true">/</span>{' '}
            {clockLabel(payload.clock?.phase)}
          </span>
        </div>
      </section>

      <footer className="program-foundation-probe__footer">本地测试场景 · 不加载外部资源</footer>
    </div>
  );
}
