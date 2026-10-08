import { useEffect, useRef, useState } from 'react';
import type { ReplaySession } from '@mizar/replay';
import type { AcceptanceReplayFrame } from './replay-fixture';

export interface ReplayVideoSource {
  readonly url: string;
  /** Video time zero corresponds to this position on the shared replay timeline. */
  readonly timelineStartUs: number;
}

export function ReplayVideoBackground({
  source,
  session,
}: {
  readonly source: ReplayVideoSource;
  readonly session: ReplaySession<AcceptanceReplayFrame>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let active = true;
    let request = 0;
    let playPending = false;
    const fail = () => {
      if (!active) return;
      session.pause();
      setFailed(true);
    };
    const sync = () => {
      if (!active || video.readyState === 0) return;
      const state = session.getSnapshot();
      const time = Math.max(0, (session.getPlaybackElapsedUs() - source.timelineStartUs) / 1e6);
      const target = Math.min(time, Number.isFinite(video.duration) ? video.duration : time);
      const playing = state.isPlaying && !state.isSeeking && time < video.duration;
      video.playbackRate = session.getPlaybackSpeed();
      // Pause/seek must land exactly; during playback only correct visible drift.
      if (
        (!playing && Math.abs(video.currentTime - target) > 0.001) ||
        (playing && Math.abs(video.currentTime - target) > 0.1)
      ) {
        video.currentTime = target;
      }
      if (!playing) video.pause();
      else if (video.paused && !playPending) {
        playPending = true;
        void video
          .play()
          .catch((error: unknown) => {
            // An intentional pause/source change can interrupt an outstanding play request.
            if (
              active &&
              session.getSnapshot().isPlaying &&
              !(error instanceof DOMException && error.name === 'AbortError')
            )
              fail();
          })
          .finally(() => {
            playPending = false;
          });
      }
    };
    const tick = () => {
      sync();
      request = requestAnimationFrame(tick);
    };
    const unsubscribe = session.subscribe(sync);
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('error', fail);
    request = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(request);
      unsubscribe();
      video.removeEventListener('loadedmetadata', sync);
      video.removeEventListener('error', fail);
      video.pause();
    };
  }, [session, source]);

  return (
    <>
      <video
        ref={videoRef}
        className="hud-console__map-background"
        src={source.url}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      {failed ? <span role="alert">游戏背景加载失败，请重新载入回放。</span> : null}
    </>
  );
}
