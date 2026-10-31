import { useState } from 'react';
import type { SeriesBindingView } from '@mizar/protocol/operator';
import { Button, Panel, Select, StatusBanner } from '../ui';
import { command, openTool, useLocalRead } from './client';

export function SeriesBindingControls() {
  const [refresh, setRefresh] = useState(0);
  const result = useLocalRead<{ binding: SeriesBindingView | null }>(
    '/local/v1/series-binding',
    1000,
    refresh,
  );
  const view = result?.binding;
  const [review, setReview] = useState<SeriesBindingView | null>(null);
  const [mapOrder, setMapOrder] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  if (view?.canBind && review === null) setReview(view);
  if (view?.bindingState !== 'needs_operator' && view?.ownership?.status !== 'attention')
    return message ? <StatusBanner tone="info">{message}</StatusBanner> : null;
  const selected = review?.targets.length === 1 ? String(review.targets[0]!.mapOrder) : mapOrder;
  const expired = review?.revision !== view.revision;
  return (
    <Panel role="region" aria-label="确认当前地图所属场次">
      <h2>确认当前图</h2>
      {view.ownership?.reason === 'previous_execution' ? (
        <StatusBanner tone="warning">
          当前游戏执行属于上一场，不能直接改绑本场。请结束旧游戏并重新启动本场受管游戏；若使用外部游戏，请等待新的实际地图执行后再确认。
        </StatusBanner>
      ) : view.ownership?.reason === 'recovery_unverified' ? (
        <StatusBanner tone="warning">
          恢复记录缺少当前执行的归属证明。请重新启动本场受管游戏；外部游戏需在新的实际地图执行后确认当前图。
        </StatusBanner>
      ) : view.ownership?.reason === 'new_execution_unverified' ? (
        <StatusBanner tone="warning">
          已观察到新的地图执行，但它属于哪场比赛仍待确认。核对现场地图和名单后，可在此确认当前图。
        </StatusBanner>
      ) : null}
      <p>当前游戏：{view.mapName ?? '等待游戏数据'}。已有比分和地图计划会保留。</p>
      {view.canBind && review ? (
        <>
          {review.targets.length === 1 ? (
            <p>对应本场第 {review.targets[0]!.mapOrder} 图。</p>
          ) : (
            <Select
              label="当前是本场第几图"
              value={mapOrder}
              onChange={(event) => setMapOrder(event.target.value)}
            >
              <option value="">请选择</option>
              {review.targets.map((target) => (
                <option key={target.mapOrder} value={target.mapOrder}>
                  第 {target.mapOrder} 图 · {target.mapName}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="primary"
            loading={busy}
            disabled={!selected || expired || busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void command('/operator/series/bind', {
                kind: 'bind-current-map-execution-to-series-map',
                mapOrder: Number(selected),
                expectedRevision: review.revision,
                reason: `现场确认 ${review.mapName} 对应本场第 ${selected} 图`,
              })
                .then(() => {
                  setMessage(`已确认当前是第 ${selected} 图。`);
                  setRefresh((current) => current + 1);
                })
                .catch((cause: Error) => setError(cause.message))
                .finally(() => setBusy(false));
            }}
          >
            确认当前是第 {selected || '…'} 图
          </Button>
          {expired ? (
            <>
              <StatusBanner tone="warning">比赛或地图已变化，请重新核对。</StatusBanner>
              <Button
                disabled={busy}
                onClick={() => {
                  setReview(view);
                  setMapOrder('');
                  setError('');
                }}
              >
                重新核对当前图
              </Button>
            </>
          ) : null}
        </>
      ) : (
        <StatusBanner tone="warning">
          {view.blockedReason === 'awaiting_data'
            ? '等待完整游戏数据；恢复观战数据后会重新检查。'
            : view.blockedReason === 'execution_owned_elsewhere'
              ? '已有执行不能改绑其他比赛。'
              : view.blockedReason === 'execution_unverified'
                ? '等待可确认的新地图执行，或重新启动本场受管游戏。'
                : view.blockedReason === 'identity_unverified'
                  ? '先核对实际游戏地图与本场名单。身份核验通过后才能确认当前图。'
                  : view.blockedReason === 'series_completed'
                    ? '本场已结束，不能覆盖已有地图记录。'
                    : '当前地图没有可用的未完成位置。这里不能补录上一图结果或新增地图；请保留记录并导出诊断反馈。'}
        </StatusBanner>
      )}
      {!view.canBind && view.blockedReason === 'no_matching_map' ? (
        <Button
          onClick={() =>
            void openTool('diagnostics').catch(() =>
              setError('诊断页面未能打开，请从高级设置导出。'),
            )
          }
        >
          导出诊断反馈
        </Button>
      ) : null}
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </Panel>
  );
}
