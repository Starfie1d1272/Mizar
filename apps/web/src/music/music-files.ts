import { controlEvidence, browserErrorEvidence } from '../debug/control-journal';
import type { MusicView } from './MusicControls';
import type { MusicTrack } from '@mizar/protocol/music';
import type { PortableTrack } from '@mizar/broadcast-config';

export type UploadedMusicTrack = MusicTrack & { portable: PortableTrack };

export async function localFile<T = MusicView & MusicTrack>(url: string, file: File, type: string) {
  const operationId = crypto.randomUUID();
  controlEvidence('music_file', 'selected', {
    operationId,
    name: file.name,
    bytes: file.size,
    type: file.type,
    destination: url,
  });
  let body: ArrayBuffer;
  controlEvidence('music_file', 'read_begin', { operationId, name: file.name, bytes: file.size });
  try {
    body = await file.arrayBuffer();
  } catch (error) {
    controlEvidence('music_file', 'read_failed', {
      operationId,
      error: browserErrorEvidence(error),
    });
    throw new Error('文件未能读取，请确认文件仍在原位置且可以访问后重新选择。', { cause: error });
  }
  controlEvidence('music_file', 'read_success', { operationId, bytes: body.byteLength });
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': type,
        'x-mizar-filename': encodeURIComponent(file.name),
        'x-mizar-operation-id': operationId,
      },
      body,
    });
  } catch (error) {
    controlEvidence('music_file', 'upload_failed', {
      operationId,
      error: browserErrorEvidence(error),
    });
    throw new Error('曲目未能传到本机服务，请确认 Mizar 正在运行后重试。', { cause: error });
  }
  controlEvidence('music_file', 'uploaded', { operationId, status: response.status });
  if (!response.ok) {
    const reason = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      reason?.message ??
        (url.endsWith('import')
          ? '音乐包未导入，原配置已保留。请检查 music.json、文件格式与大小限制。'
          : '曲目未添加，请检查音频格式与大小（最大 32 MiB）。'),
    );
  }
  return response.json() as Promise<T>;
}
