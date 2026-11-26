import { afterEach, describe, expect, it } from 'vitest';
import { getRadarArtwork } from '../src/assets.js';
import { RadarView } from '../src/Radar.js';
import { RadarPresentation } from '../src/presentation.js';
import { WebGL2RadarRenderer } from '../src/webgl-renderer.js';
import type { RadarViewFrame } from '../src/types.js';

function createMockCanvasAndGl() {
  const boundTextures: unknown[] = [];
  let createdTextures = 0;
  let drawCalls = 0;

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    COLOR_BUFFER_BIT: 0x4000,
    SCISSOR_TEST: 0x0c11,
    BLEND: 0x0be2,
    ONE: 1,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLE_STRIP: 0x0005,
    isContextLost: () => false,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {},
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},
    bindVertexArray: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    getUniformLocation: () => ({}),
    useProgram: () => {},
    uniform4f: () => {},
    uniform1i: () => {},
    viewport: () => {},
    scissor: () => {},
    enable: () => {},
    disable: () => {},
    clearColor: () => {},
    clear: () => {},
    blendFunc: () => {},
    activeTexture: () => {},
    createTexture: () => ({ id: ++createdTextures }),
    deleteTexture: () => {},
    bindTexture: (_target: number, tex: unknown) => {
      boundTextures.push(tex);
    },
    pixelStorei: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    drawArraysInstanced: () => {
      drawCalls += 1;
    },
  } as unknown as WebGL2RenderingContext;

  const ctx2d = {
    setTransform: () => {},
    clearRect: () => {},
    fillText: () => {},
    fillRect: () => {},
    drawImage: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    clip: () => {},
    translate: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    font: '',
    fillStyle: '',
    textAlign: 'center',
    textBaseline: 'middle',
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };

  const origDoc = globalThis.document;
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ctx2d,
    }),
  };

  return {
    gl,
    getCreatedTextures: () => createdTextures,
    getBoundTextures: () => boundTextures,
    getDrawCalls: () => drawCalls,
    restore: () => {
      (globalThis as Record<string, unknown>).document = origDoc;
    },
  };
}

function makeFrame(seq: number, x = 0.5, bombState: string | null = null): RadarViewFrame {
  const artwork = getRadarArtwork('de_ancient')!;
  return {
    boundary: 'b1',
    sequence: seq,
    sampleSequence: seq,
    mapName: 'de_ancient',
    calibrationRevision: artwork.calibrationRevision,
    layers: ['single'],
    activeLayer: 'single',
    payload: {
      players: [
        {
          sourcePlayerId: 'p1',
          side: 'CT',
          lifeState: 'alive',
          position: { x, y: 0.5, layer: 'single' },
          facing: { x: 1, y: 0 },
          label: '1',
          health: 100,
        },
        {
          sourcePlayerId: 'p2',
          side: 'T',
          lifeState: 'alive',
          position: { x: 0.3, y: 0.4, layer: 'single' },
          facing: { x: -1, y: 0 },
          label: '2',
          health: 100,
        },
      ],
      bomb: bombState ? { position: { x: 0.5, y: 0.5, layer: 'single' }, state: bombState } : null,
      grenades: [],
      observedPlayerSourceId: 'p1',
    },
  };
}

describe('WebGL 2 radar renderer and scheduling', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('shares a single static glyph grid texture across 0-9 and A/B without corrupting batches', () => {
    const mock = createMockCanvasAndGl();
    cleanup = mock.restore;

    const renderer = new WebGL2RadarRenderer(mock.gl);
    renderer.beginFrame(512, 0.5, 0.5, 1);

    const g1 = renderer.cache.glyph('1', '800 42px Inter, sans-serif', '#0b1119')!;
    const g2 = renderer.cache.glyph('2', '800 42px Inter, sans-serif', '#0b1119')!;
    const gA = renderer.cache.glyph('A', '800 42px Inter, sans-serif', '#0b1119')!;

    expect(mock.getCreatedTextures()).toBe(1);
    expect(g1.texture).toBe(g2.texture);
    expect(g1.texture).toBe(gA.texture);
    expect(g1.u0).not.toBe(g2.u0);

    renderer.drawTexturedQuad(g1, 100, 100, 38, 38, 1);
    renderer.drawTexturedQuad(g2, 200, 200, 38, 38, 1);
    renderer.drawTexturedQuad(gA, 300, 300, 38, 38, 1);
    renderer.endFrame();

    // All 3 glyphs share 1 texture and submit in a single instanced draw call.
    expect(mock.getDrawCalls()).toBe(1);
    renderer.dispose();
  });

  it('stops active motion when stationary and resumes on new frame or planted bomb', () => {
    const model = new RadarPresentation();
    model.accept(makeFrame(1, 0.5), 1000);
    model.tick(1000, false, false);
    expect(model.hasActiveMotion(1000, false)).toBe(false);

    // Moving player triggers interpolation motion, then settles.
    model.accept(makeFrame(2, 0.505), 1050);
    model.tick(1060, false, false);
    expect(model.hasActiveMotion(1060, false)).toBe(true);

    model.tick(1500, false, false);
    expect(model.hasActiveMotion(1500, false)).toBe(false);

    // Planted bomb keeps pulse active.
    model.accept(makeFrame(3, 0.505, 'planted'), 1600);
    model.tick(1600, false, false);
    expect(model.hasActiveMotion(1600, false)).toBe(true);
  });

  it('exports RadarView component and supports WebGL2RadarRenderer context loss/restore', () => {
    expect(typeof RadarView).toBe('function');
    const mock = createMockCanvasAndGl();
    cleanup = mock.restore;
    const renderer = new WebGL2RadarRenderer(mock.gl);
    renderer.handleContextLost();
    expect(renderer.handleContextRestored()).toBe(true);
    renderer.dispose();
  });
});
