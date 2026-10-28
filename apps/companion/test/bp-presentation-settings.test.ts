import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { BpPresentationSettings } from '../src/bp/presentation-settings.js';

it('defaults to full, persists the choice and rejects stale writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-presentation-'));
  try {
    const path = join(dir, 'settings.json');
    const store = new BpPresentationSettings(path);
    await store.load();
    expect(store.get().mode).toBe('full');
    const revision = store.get().revision;
    expect(await store.set('compact', revision)).toBe(true);
    expect(await store.set('full', revision)).toBe(false);
    const restored = new BpPresentationSettings(path);
    await restored.load();
    expect(restored.get().mode).toBe('compact');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
