import { useEffect, useRef, useState } from 'react';
import { programTransition, type ProgramSceneId } from '@mizar/protocol/program-scenes';

export interface PreviewFrame {
  readonly key: string;
  readonly scene: ProgramSceneId;
  readonly src: string;
  readonly immediate: boolean;
}

/** One viewport, bounded to the on-screen frame and one latest incoming frame. */
export function ScenePreviewViewport({
  frame,
  onSettled,
}: {
  readonly frame: PreviewFrame;
  readonly onSettled: (key: string) => void;
}) {
  const [current, setCurrent] = useState(frame);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const requested = useRef(frame);
  const animation = useRef<Animation | null>(null);
  const incoming = current.key === frame.key || failedKey === frame.key ? null : frame;

  useEffect(() => {
    requested.current = frame;
    animation.current?.cancel();
    if (current.key === frame.key) return;
    const timer = setTimeout(() => {
      if (requested.current.key === frame.key) setFailedKey(frame.key);
    }, 5000);
    return () => {
      clearTimeout(timer);
      animation.current?.cancel();
    };
  }, [frame, current.key]);

  function loaded(item: PreviewFrame, element: HTMLIFrameElement) {
    if (item.key !== requested.current.key) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const transition = programTransition(current.scene, item.scene, item.immediate || reduced);
    const finish = () => {
      if (item.key !== requested.current.key) return;
      setCurrent(item);
      onSettled(item.key);
    };
    if (item.key === current.key || transition.kind === 'cut') {
      finish();
      return;
    }
    animation.current = element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: transition.durationMs,
      easing: 'linear',
      fill: 'forwards',
    });
    void animation.current.finished.then(finish, () => {});
  }

  return (
    <div className="preparation-program-preview" data-transitioning={incoming !== null}>
      {[current, ...(incoming ? [incoming] : [])].map((item) => (
        <iframe
          key={item.key}
          title={incoming && item.key === current.key ? '节目预览（上一场景）' : '节目预览'}
          aria-hidden={incoming !== null && item.key === current.key}
          tabIndex={-1}
          src={item.src}
          style={{ opacity: item.key === current.key ? 1 : 0 }}
          onLoad={(event) => loaded(item, event.currentTarget)}
        />
      ))}
      {failedKey === frame.key ? (
        <p className="program-preview-error" role="alert">
          画面加载未完成，请重新选择场景。
        </p>
      ) : null}
    </div>
  );
}
