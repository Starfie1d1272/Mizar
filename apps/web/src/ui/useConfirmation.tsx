import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from './primitives';

/** A pending choice is cancelled on unmount; repeated requests cannot replace it. */
export function useConfirmation() {
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const confirm = useCallback((text: string) => {
    if (pending.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setMessage(text);
    });
  }, []);
  const finish = useCallback((accepted: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setMessage(null);
    resolve?.(accepted);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    [],
  );
  return {
    confirm,
    dialog: (
      <Dialog
        className="mizar-surface"
        open={message !== null}
        title="确认操作"
        onClose={() => finish(false)}
        showCloseButton={false}
        actions={
          <>
            <Button autoFocus onClick={() => finish(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => finish(true)}>
              确认继续
            </Button>
          </>
        }
      >
        <p>{message}</p>
      </Dialog>
    ),
  };
}
