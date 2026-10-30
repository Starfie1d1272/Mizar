type Named = { id: string; name: string };
const reasons: Record<string, string> = {
  capability_unsupported: '包含不支持分享的内容',
  resource_missing: '所需素材缺失',
  resource_damaged: '所需素材已损坏',
  resource_unsupported: '素材格式不受支持',
  dependency_missing: '所需来源不可用',
  export_failed: '暂时无法导出',
};
export async function exportFailure(
  response: Response,
  modules: Named[],
  presets: Named[],
): Promise<string> {
  if (response.status === 409) return '配置已变化，请刷新后重试。';
  if (response.status !== 422) return '导出未完成，请检查本地制播服务后重试。';
  const result = (await response.json().catch(() => ({}))) as {
    entries?: { type: 'module' | 'preset'; id: string; reason: string }[];
  };
  const details = result.entries?.map((entry) => {
    const name =
      (entry.type === 'module' ? modules : presets).find((item) => item.id === entry.id)?.name ??
      (entry.type === 'module' ? '资源' : '方案');
    return `「${name}」${reasons[entry.reason] ?? '暂时无法导出'}`;
  });
  return details?.length ? `导出未完成：${details.join('；')}。` : '导出未完成，请检查资源和来源。';
}
