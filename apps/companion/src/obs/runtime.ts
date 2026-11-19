import type { FastifyInstance } from 'fastify';
import { ObsConfigStore } from './config.js';
import { ObsAudioRouting } from './audio-routing.js';
import { GameAudioController } from './audio-policy-controller.js';
import { ObsAdapter, obsErrorEvidence } from './adapter.js';
import { RemoteCommentary } from './remote-commentary.js';
import { ObsVideoTransaction } from './video-transaction.js';
import { ObsCaptureWarmup } from './capture-warmup.js';

export function createObsRuntime(
  app: FastifyInstance,
  options: { configPath: string | undefined; httpOrigin: string; appVersion: string },
) {
  const { configPath } = options;
  if (configPath === undefined)
    return {
      configStore: undefined,
      adapter: undefined,
      gameAudio: undefined,
      audioRouting: undefined,
    };
  const configStore = new ObsConfigStore(configPath);
  const audioRouting = new ObsAudioRouting(`${configPath}.audio-routing.json`);
  const gameAudio = configPath
    ? new GameAudioController(audioRouting, configStore, `${configPath}.game-audio.json`)
    : undefined;
  if (gameAudio)
    app.addHook('onReady', async () => {
      await gameAudio
        .load()
        .catch((error) => app.log.error({ err: error }, '游戏音频策略加载失败'));
    });
  const adapter = new ObsAdapter(
    configStore,
    options.httpOrigin,
    (stage, error) =>
      app.log.warn(
        { event: 'obs', stage, result: 'failure', diagnostic: { error } },
        'OBS request failed',
      ),
    audioRouting,
    {
      owner: new RemoteCommentary(`${configPath}.commentary.json`),
      journal: `${configPath}.commentary-probe.json`,
    },
    new ObsVideoTransaction(`${configPath}.video-transaction.json`),
    new ObsCaptureWarmup(`${configPath}.capture-warmup.json`),
    options.appVersion,
  );
  app.addHook('onReady', async () => {
    await adapter
      .restoreVideo()
      .then(() => adapter.restoreProgram())
      .catch(async (error: unknown) =>
        app.log.warn(
          {
            event: 'obs',
            stage: 'production_recovery',
            diagnostic: { error: obsErrorEvidence(error, (await configStore.read())?.password) },
          },
          'OBS production recovery pending',
        ),
      );
  });
  return { configStore, adapter, gameAudio, audioRouting };
}
