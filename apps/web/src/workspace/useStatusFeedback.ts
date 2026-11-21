import { useEffect, useRef, useState } from 'react';

export type WorkbenchStatus = 's0' | 's1' | 's2' | 's3';

export function useStatusFeedback(status: WorkbenchStatus) {
  const previous = useRef(status);
  const [feedback, setFeedback] = useState<'pulse' | 'recovered' | null>(null);
  useEffect(() => {
    const from = previous.current;
    previous.current = status;
    const next =
      from === 's0' && (status === 's2' || status === 's3')
        ? 'pulse'
        : (from === 's2' || from === 's3') && status === 's0'
          ? 'recovered'
          : null;
    const start = setTimeout(() => setFeedback(next), 0);
    const end = next ? setTimeout(() => setFeedback(null), 1600) : null;
    return () => {
      clearTimeout(start);
      if (end !== null) clearTimeout(end);
    };
  }, [status]);
  return feedback;
}
