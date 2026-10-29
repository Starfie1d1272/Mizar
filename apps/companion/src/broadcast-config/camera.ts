import type { CameraModuleV2, CameraSourceRef, MulnxToolRef } from '@mizar/broadcast-config';
import { orchestrationPresetSchema, type OrchestrationPreset } from '@mizar/protocol/orchestration';
import type { MusicStore } from '../music/store.js';
import type { MulnxTool } from '../orchestration/tool.js';
import { portableMusicTrack } from './music-assets.js';

/** Caller owns the production lifecycle guard and supplies actual tool capability evidence. */
export class CameraConfigResolver {
  constructor(
    private readonly tool: MulnxTool,
    private readonly music: MusicStore,
    private readonly supportsCamera: (tool: MulnxToolRef) => Promise<boolean>,
  ) {}

  async cameraConfig(
    input: OrchestrationPreset,
    automaticEnabled: boolean,
  ): Promise<CameraModuleV2> {
    const preset = orchestrationPresetSchema.parse(input);
    const maps = await Promise.all(
      preset.maps.map(async ({ pack, openingSound, ...map }) => ({
        ...map,
        source: await this.tool.cameraSource(pack),
        openingSound: openingSound ? await portableMusicTrack(this.music, openingSound) : null,
      })),
    );
    return { format: 'mizar.camera-config', version: 2, name: preset.name, automaticEnabled, maps };
  }

  async camera(source: CameraSourceRef): Promise<MulnxToolRef> {
    const selected = await this.tool.resolveCameraSource(source);
    if (!(await this.supportsCamera(selected))) throw new Error('mulnx_capability_unavailable');
    const checked = await this.tool.resolveCameraSource(source);
    if (JSON.stringify(checked) !== JSON.stringify(selected))
      throw new Error('mulnx_source_unavailable');
    return checked;
  }
}
