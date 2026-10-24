import { observerConnectionSchema, type ObserverConnection } from '@mizar/protocol/assist';
import { fileURLToPath } from 'node:url';

/** Fixed operations through MulNX's existing command queue, scoped by the native game lease. */
export async function sendObserverGameCommand(command: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await submit(command);
      return;
    } catch (error) {
      // Retry readiness only. Once open, submission may have reached the engine.
      if (
        !(error instanceof Error) ||
        error.message !== 'observer_game_control_connect' ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
function submit(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:55202');
    const wire = JSON.stringify({
      type: 'Game/Command/NoReport',
      payload: JSON.stringify(command),
    });
    let opened = false,
      done = false;
    let timer = setTimeout(() => finish(new Error('observer_game_control_connect')), 700);
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error('observer_game_control_timeout')), 3000);
      try {
        socket.send(wire);
      } catch {
        finish(new Error('observer_game_control_unavailable'));
      }
    });
    socket.addEventListener('message', (message) => {
      if (message.data === '已投入消息总线' + wire) finish();
      else if (typeof message.data === 'string' && message.data.startsWith('error:'))
        finish(new Error('observer_game_command_rejected'));
    });
    const disconnected = () =>
      finish(new Error(opened ? 'observer_game_control_closed' : 'observer_game_control_connect'));
    socket.addEventListener('error', disconnected);
    socket.addEventListener('close', () => {
      if (!done) disconnected();
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--observer-query' ||
    ![2, 3].includes(args.length) ||
    (args[2] !== undefined && args[2] !== '0' && args[2] !== '1')
  )
    throw new Error('observer_hud_arguments');
  await sendObserverGameCommand(
    observerHudQuery(args[1]!, args[2] === undefined ? undefined : (Number(args[2]) as 0 | 1)),
  );
  console.log(JSON.stringify({ queued: true }));
}

export function observerConnectCommand(connection: ObserverConnection, hideHud: boolean) {
  const parsed = observerConnectionSchema.parse(connection);
  return `password "${parsed.password}";connect ${parsed.programEndpoint}${hideHud ? ';cl_draw_only_deathnotices 1' : ''}`;
}
export function observerHudQuery(marker: string, value?: 0 | 1) {
  if (!/^MIZAR_HUD_[a-f0-9]{32}$/.test(marker)) throw new Error('observer_hud_marker');
  return `echo ${marker};${value === undefined ? '' : `cl_draw_only_deathnotices ${value};`}cl_draw_only_deathnotices`;
}
