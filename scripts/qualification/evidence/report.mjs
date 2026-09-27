import { basename } from 'node:path';

import { objectiveScenarioLabel } from './objective-timing.mjs';

function resultLabel(result) {
  if (result === 'PASS') return '通过';
  if (result === 'FAIL') return '失败';
  return '证据不足';
}

function freshnessLabel(value) {
  if (value === 'fresh') return '正常';
  if (value === 'stale') return '已过期';
  if (value === 'awaiting') return '等待数据';
  return '未知';
}

function objectiveTimingLabel(value) {
  if (value === 'PASS') return '通过';
  if (value === 'FAIL') return '失败';
  if (value === 'NOT_PROMISED') return '不承诺';
  return '证据不足';
}

function qualificationProfileLabel(value) {
  if (value === 'objective-timing') return '目标时钟专项验收';
  if (value === 'release') return '生产环境准入验收（Release Profile）';
  return '常规现场验收';
}

function truthLabel(value, inconclusive = '证据不足') {
  if (value === true) return '完整';
  if (value === false) return '不完整';
  return inconclusive;
}

function markerLabel(marker) {
  const labels = {
    'demo-a-live': '第一场数据正常',
    'cs2-closed': 'CS2 已退出',
    'runtime-stale': '数据已过期',
    'next-execution': '开始下一场执行',
    'cs2-reopened': 'CS2 已重开',
    'demo-b-live': '第二场数据正常',
  };
  if (marker.kind.startsWith('objective-')) {
    const phase =
      marker.phase === 'before' ? '开始' : marker.phase === 'after' ? '结束' : '未知阶段';
    return `目标时钟：${objectiveScenarioLabel(marker.kind.slice('objective-'.length))}（${phase}）`;
  }
  return labels[marker.kind] ?? '其他场景标记';
}

export function renderReport({
  qualification,
  artifact,
  scenario,
  finalRuntime,
  captureResults,
  captureErrors,
  objectiveTimingCoverage,
  objectiveTiming,
  qualificationProfile = qualification.profile ?? 'base',
  checks,
  hostCheckpoints = [],
}) {
  const lines = [
    '# Mizar 现场验收报告',
    '',
    `- 结果：**${resultLabel(qualification.result)}**`,
    `- 运行编号：\`${qualification.runId}\``,
    `- Git SHA：\`${artifact.gitSha}\``,
    `- Node 运行时：\`${artifact.nodeVersion}\``,
    `- 现场验收类型：${qualificationProfileLabel(qualificationProfile)}`,
    '',
    '## 验收检查',
    '',
  ];
  for (const check of Object.values(checks))
    lines.push(`- ${check.label}：**${resultLabel(check.status)}** — ${check.reason}`);
  lines.push(
    '',
    '## 采集记录',
    '',
    `- 已验证采集：${captureResults.length}`,
    `- 采集错误：${captureErrors.length}`,
  );
  for (const capture of captureResults) {
    lines.push(
      `- \`${basename(capture.directory)}\`：${capture.frameCount} 帧，${capture.computedFramesSha256}`,
    );
    if (capture.objectiveTiming !== undefined) {
      const objective = capture.objectiveTiming;
      lines.push(
        `  - 目标证据基础判定：**${objectiveTimingLabel(objective.qualification.foundation.result)}**`,
        `  - 目标时钟数值精度 0.1 秒：**${objectiveTimingLabel(objective.qualification.numeric01s.result)}**；活动数据间隔 p99 ${objective.metrics.activePacketIntervalMs.p99 === null ? '未知' : `${objective.metrics.activePacketIntervalMs.p99.toFixed(1)} 毫秒`}；重连间隔 ${objective.metrics.reconnectGaps.count} 次`,
        `  - 目标时钟数值精度 0.01 秒：**${objectiveTimingLabel(objective.qualification.numeric001s.result)}**`,
        `  - 目标时钟证据：场景覆盖 ${objective.evidence.scenarioCoverage.observed.length}/${objective.evidence.scenarioCoverage.required.length}；终止时刻误差样本 ${truthLabel(objective.qualification.numeric01s.gates.terminalResidualCoverage, '证据不足')}；独立事件记录 ${objective.evidence.independentObjectiveReferences.length} 条`,
        `  - 目标时钟语义一致性：**${objectiveTimingLabel(objective.qualification.sourceSemantics.result)}**；终止时刻误差界限 ${objective.qualification.numeric01s.gates.terminalResidualWithin100Ms === true ? '未超出 100 毫秒' : objective.qualification.numeric01s.gates.terminalResidualWithin100Ms === false ? '超出 100 毫秒' : '证据不足'}`,
        `  - 目标时钟短时有效窗口：配置 ${objective.metrics.lease.configuredLeaseMs.toFixed(1)} 毫秒；最低要求 ${objective.metrics.lease.requiredMinimumLeaseMs === null ? '未知' : `${objective.metrics.lease.requiredMinimumLeaseMs.toFixed(1)} 毫秒`}；是否足够 ${objective.metrics.lease.sufficient === true ? '是' : objective.metrics.lease.sufficient === false ? '否' : '证据不足'}`,
      );
    }
  }
  if (objectiveTimingCoverage !== undefined) {
    lines.push(
      '',
      '## 目标时钟场景覆盖（整轮汇总）',
      '',
      `- 已声明：${objectiveTimingCoverage.declared.length}/${objectiveTimingCoverage.required.length}`,
      `- 已验证：${objectiveTimingCoverage.observed.length}/${objectiveTimingCoverage.required.length}`,
      `- 缺少：${objectiveTimingCoverage.missing.length === 0 ? '无' : objectiveTimingCoverage.missing.map((value) => objectiveScenarioLabel(value)).join('、')}`,
      `- 已声明但未验证：${objectiveTimingCoverage.declaredMissing.length === 0 ? '无' : objectiveTimingCoverage.declaredMissing.map((value) => objectiveScenarioLabel(value)).join('、')}`,
      '- 覆盖要求：每个场景都必须由绑定到采集记录编号的“开始/结束”标记明确圈定；仅有数据间隔不能作为重连证据。',
    );
  }
  if (objectiveTiming !== undefined) {
    lines.push(
      '',
      '## 目标时钟现场验收（整轮汇总）',
      '',
      `- 采集记录：${objectiveTiming.captureIds.join('、') || '无'}`,
      `- 目标证据基础判定：**${objectiveTimingLabel(objectiveTiming.qualification.foundation.result)}**`,
      `- 数值精度 0.1 秒：**${objectiveTimingLabel(objectiveTiming.qualification.numeric01s.result)}**`,
      `- 来源语义与生命周期：**${objectiveTimingLabel(objectiveTiming.qualification.sourceSemantics.result)}**`,
      `- 场景覆盖：${objectiveTiming.evidence.scenarioCoverage.observed.length}/${objectiveTiming.evidence.scenarioCoverage.required.length}`,
      `- 终止时刻误差样本：${objectiveTiming.qualification.numeric01s.gates.terminalResidualCoverage === true ? '完整' : '证据不足'}`,
      `- 汇总方式：${objectiveTiming.evidence.aggregation.activePacketInterval}；${objectiveTiming.evidence.aggregation.observerReferenceResidual}；${objectiveTiming.evidence.aggregation.terminalResidual}`,
    );
  }
  lines.push('', '## 场景标记', '');
  if (scenario.markers.length === 0) lines.push('- 未记录场景标记。');
  else
    for (const marker of scenario.markers)
      lines.push(`- ${marker.wallClockAt} — ${markerLabel(marker)}`);

  if (qualificationProfile === 'release') {
    lines.push('', '## Host 生产场景检查点', '');
    const checkpoints = hostCheckpoints ?? [];
    if (checkpoints.length === 0) {
      lines.push('- 未记录 Host 检查点。');
    } else {
      const scenarioTitles = {
        'browser-reload': '普通浏览器重载',
        'obs-reload': 'OBS Browser Source 重载',
        'scene-visibility': 'OBS 场景可见性切换',
        'companion-restart': '制播服务受控重启',
      };
      for (const cp of checkpoints) {
        const title = scenarioTitles[cp.scenario] ?? cp.scenario;
        const phase = cp.phase === 'before' ? '前' : '后';
        const visible =
          cp.programVisible !== undefined
            ? `，目视确认：${cp.programVisible ? '画面正常' : '画面异常'}`
            : '';
        lines.push(
          `- ${cp.timestamp?.utc ?? '未知时间'} — ${title}（${phase}）[运行状态: ${freshnessLabel(cp.runtime?.freshness)}${visible}]`,
        );
      }
    }
  }
  lines.push(
    '',
    '## 最终运行状态',
    '',
    finalRuntime === undefined
      ? '- 最终运行状态文件（`final-runtime.json`）不可用'
      : `- 运行状态：**${freshnessLabel(finalRuntime.freshness)}**`,
    '',
    '本报告不包含原始访问令牌或账户身份信息。',
  );
  return `${lines.join('\n')}\n`;
}
