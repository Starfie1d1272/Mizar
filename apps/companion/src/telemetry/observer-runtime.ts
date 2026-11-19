import type { FastifyInstance } from 'fastify';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { createObserverAssistScope } from './observer-assist-scope.js';
import { ObserverSettingsStore, registerObserverSettings } from './observer-settings.js';
import { registerWorkspaceObserver, type WorkspaceObserver } from './observer-workspace.js';

export function createObserverRuntime(app: FastifyInstance, settingsPath: string | undefined) {
  const observerSettings = new ObserverSettingsStore(settingsPath);
  let observerEligible = () => false;
  const observerAssist = createObserverAssistScope(observerSettings, () => observerEligible());
  app.addHook('onReady', async () => {
    try {
      await observerSettings.load();
    } catch (error) {
      app.log.error(
        { stage: 'observer_settings_load', err: error },
        '观察辅助设置需要重新保存，基础制播继续就绪',
      );
    }
  });
  return {
    settings: observerSettings,
    assist: observerAssist,
    connect(options: {
      originPolicy: LocalWebOriginPolicy;
      projectionCoordinator: Pick<
        ProjectionCoordinator,
        'getCurrent' | 'refresh' | 'refreshAssist' | 'resetObserverAssist'
      >;
      workspaceObserver: WorkspaceObserver | undefined;
      controlToken: string | undefined;
      eligible: () => boolean;
      readBinding: () => MatchContextBinding | undefined;
      mapConnectionChanged: () => void;
    }) {
      const { originPolicy, projectionCoordinator } = options;
      observerEligible = options.eligible;
      registerObserverSettings(
        app,
        observerSettings,
        originPolicy,
        observerEligible,
        () =>
          observerEligible() &&
          projectionCoordinator.getCurrent().program.status.telemetry === 'fresh' &&
          Boolean(projectionCoordinator.getCurrent().program.map.name),
      );
      const observerSettingsUnsubscribe = observerAssist.subscribe({
        program: () => projectionCoordinator.getCurrent().program,
        refresh: () => projectionCoordinator.refresh(),
        refreshAssist: () => projectionCoordinator.refreshAssist(),
        resetAssist: () => projectionCoordinator.resetObserverAssist(),
        mapConnectionChanged: options.mapConnectionChanged,
      });
      app.addHook('onClose', () => {
        observerSettingsUnsubscribe();
      });
      if (options.workspaceObserver && options.controlToken !== undefined)
        registerWorkspaceObserver(
          app,
          options.workspaceObserver,
          options.controlToken,
          observerEligible,
          observerSettings,
          options.readBinding,
        );
    },
  };
}
