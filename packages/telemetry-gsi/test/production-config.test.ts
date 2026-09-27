import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PRODUCTION_GSI_CONFIG } from '../src/index.js';

function cfgValue(text: string, key: string): string {
  const match = text.match(new RegExp(`"${key}"\\s+"([^"]+)"`));
  if (match?.[1] === undefined) throw new Error(`missing GSI config key: ${key}`);
  return match[1];
}

describe('production GSI config contract', () => {
  it('keeps the installed cfg template aligned with the canonical JSON source', () => {
    const template = readFileSync(
      join(process.cwd(), 'config/gamestate_integration_mizar.cfg.example'),
      'utf8',
    );

    expect(cfgValue(template, 'uri')).toBe(PRODUCTION_GSI_CONFIG.uri);
    for (const key of [
      'timeout',
      'buffer',
      'throttle',
      'heartbeat',
      'precision_time',
      'precision_position',
      'precision_vector',
    ] as const) {
      expect(Number(cfgValue(template, key))).toBe(PRODUCTION_GSI_CONFIG[key]);
    }
    for (const component of PRODUCTION_GSI_CONFIG.components) {
      expect(cfgValue(template, component)).toBe('1');
    }
  });
});
