import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { MatchDocumentView } from './MatchDocumentView';

export const libraryMatchTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '待排期';

export function LibraryMatchDetails({ document }: { document: MatchDocumentV1 }) {
  return (
    <>
      <MatchDocumentView document={document} section="details" />
      <MatchDocumentView document={document} section="roster" rosterCounts />
      <details>
        <summary>地图与禁选资料</summary>
        <MatchDocumentView document={document} section="maps" />
      </details>
    </>
  );
}
