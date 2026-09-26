import { useEffect, useState } from 'react';
import {
  bpSnapshotSchema,
  bpWorkspaceSchema,
  type BpSnapshot,
  type BpWorkspace,
  type LocalBpDraft,
} from '@rivalhub-broadcast/protocol/bp';

export function useBpSession() {
  const [value, setValue] = useState<{ snapshot: BpSnapshot | null; animate: boolean }>({
    snapshot: null,
    animate: false,
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    let etag: string | null = null;
    let baseline = true;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 1500);
      try {
        const response = await fetch('/local/v1/bp', {
          signal: controller.signal,
          headers: etag === null ? {} : { 'If-None-Match': etag },
        });
        if (response.status !== 304) {
          if (!response.ok) throw new Error('BP unavailable');
          const snapshot = bpSnapshotSchema.parse(await response.json());
          if (active) {
            const animate = !baseline;
            setValue({ snapshot, animate });
            etag = response.headers.get('etag');
            baseline = false;
          }
        }
      } catch {
        if (active) {
          setValue({ snapshot: null, animate: false });
          etag = null;
          baseline = true;
        }
      } finally {
        clearTimeout(timeout);
        if (active) timer = setTimeout(() => void poll(), 250);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);
  return value;
}

export function useBpWorkspace() {
  const [value, setValue] = useState<{
    workspace: BpWorkspace | null;
    connected: boolean;
    loading: boolean;
  }>({
    workspace: null,
    connected: false,
    loading: true,
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 1500);
      try {
        const response = await fetch('/local/v1/bp-workspace', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('BP workspace unavailable');
        const workspace = bpWorkspaceSchema.parse(await response.json());
        if (active) setValue({ workspace, connected: true, loading: false });
      } catch {
        if (active) setValue({ workspace: null, connected: false, loading: false });
      } finally {
        clearTimeout(timeout);
        if (active) timer = setTimeout(() => void poll(), 1000);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);
  return value;
}

export async function sendBpCommand(kind: 'play' | 'hide', expectedRevision: string) {
  const response = await fetch('/operator/bp-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, expectedRevision }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? 'BP 状态已更新，请核对后重试。'
        : '操作未确认，请检查连接和当前状态。',
    );
}

async function postBpWorkspaceCommand(
  path: '/operator/bp-local-save' | '/operator/bp-rivalhub',
  body: Record<string, unknown>,
) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  let message: string | undefined;
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === 'string') message = payload.message;
  } catch {
    // Use the bounded local copy below when the server has no JSON response.
  }
  if (!response.ok) throw new Error(message ?? '操作未完成，请检查当前比赛状态。');
  return message ?? '已完成。';
}

export function saveLocalBp(draft: LocalBpDraft, expectedContextRevision: string) {
  return postBpWorkspaceCommand('/operator/bp-local-save', { draft, expectedContextRevision });
}

export function switchToRivalhubBp(
  expectedContextRevision: string,
  expectedPendingRevision: string,
) {
  return postBpWorkspaceCommand('/operator/bp-rivalhub', {
    expectedContextRevision,
    expectedPendingRevision,
  });
}
