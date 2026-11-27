import { describe, expect, it } from 'vitest';
import { computeAspectRatioScale, computeMinBudgetStyle } from './ScaledCanvas';

describe('computeMinBudgetStyle', () => {
  it('ignores zero or negative container dimensions', () => {
    expect(computeMinBudgetStyle(0, 0, 1280, 240)).toBeNull();
    expect(computeMinBudgetStyle(0, 240, 1280, 240)).toBeNull();
    expect(computeMinBudgetStyle(1280, 0, 1280, 240)).toBeNull();
  });

  it('fills 100% without zoom when container meets or exceeds 1280x240', () => {
    expect(computeMinBudgetStyle(1280, 240, 1280, 240)).toEqual({ width: '100%', height: '100%' });
    expect(computeMinBudgetStyle(1440, 390, 1280, 240)).toEqual({ width: '100%', height: '100%' });
    expect(computeMinBudgetStyle(1920, 360, 1280, 240)).toEqual({ width: '100%', height: '100%' });
  });

  it('scales down proportionally while filling both dimensions when constrained', () => {
    expect(computeMinBudgetStyle(960, 180, 1280, 240)).toEqual({
      width: 1280,
      height: 240,
      zoom: 0.75,
    });
    expect(computeMinBudgetStyle(1152, 216, 1280, 240)).toEqual({
      width: 1280,
      height: 240,
      zoom: 0.9,
    });
    expect(computeMinBudgetStyle(768, 336, 1280, 240)).toEqual({
      width: 1280,
      height: 560,
      zoom: 0.6,
    });
  });
});

describe('computeAspectRatioScale', () => {
  it('ignores zero or negative container dimensions', () => {
    expect(computeAspectRatioScale(0, 0, 1920, 1080)).toBeNull();
    expect(computeAspectRatioScale(1920, 0, 1920, 1080)).toBeNull();
  });

  it('keeps 16:9 proportional scale on wide and tall containers', () => {
    expect(computeAspectRatioScale(2560, 1080, 1920, 1080)).toBe(1);
    expect(computeAspectRatioScale(1920, 1440, 1920, 1080)).toBe(1);
    expect(computeAspectRatioScale(960, 1080, 1920, 1080)).toBe(0.5);
    expect(computeAspectRatioScale(1280, 720, 1920, 1080)).toBeCloseTo(2 / 3);
  });
});
