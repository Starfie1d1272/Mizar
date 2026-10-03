export interface RadarEffectPoint {
  readonly x: number;
  readonly y: number;
}

export interface SmokeLobe {
  readonly dx: number;
  readonly dy: number;
  readonly radius: number;
}

function seedValue(seed: string): number {
  let value = 17;
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 131 + seed.charCodeAt(index)) % 2147483647;
  }
  return value;
}

function unit(seed: string, salt: number): number {
  let value = (seedValue(seed) + salt * 48271) % 2147483647;
  value = (value * 16807) % 2147483647;
  return value / 2147483647;
}

export function smokeLobes(seed: string, radius: number): readonly SmokeLobe[] {
  const rotation = unit(seed, 1) * Math.PI * 2;
  const lobes: SmokeLobe[] = [{ dx: 0, dy: 0, radius: radius * 0.72 }];

  for (let index = 0; index < 8; index += 1) {
    const angle = rotation + (index / 8) * Math.PI * 2 + (unit(seed, 10 + index) - 0.5) * 0.34;
    const distance = radius * (0.24 + unit(seed, 30 + index) * 0.2);
    lobes.push({
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      radius: radius * (0.42 + unit(seed, 50 + index) * 0.16),
    });
  }
  return lobes;
}

export function smokeContour(
  seed: string,
  radius: number,
  segments = 18,
): readonly RadarEffectPoint[] {
  const rotation = unit(seed, 90) * Math.PI * 2;
  return Array.from({ length: segments }, (_, index) => {
    const angle = rotation + (index / segments) * Math.PI * 2;
    const variation = 0.9 + (unit(seed, 100 + index) - 0.5) * 0.18;
    return {
      x: Math.cos(angle) * radius * variation,
      y: Math.sin(angle) * radius * variation,
    };
  });
}

export function effectCentroid(points: readonly RadarEffectPoint[]): RadarEffectPoint | null {
  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}
