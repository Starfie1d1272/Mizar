import { RADAR_CANVAS_GEOMETRY } from './canvas-geometry.js';
import { RadarTextureCache, type TextureRegion } from './texture-cache.js';

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec4 a_rect;
layout(location = 1) in vec4 a_rotAlpha;
layout(location = 2) in vec4 a_uvRect;
layout(location = 3) in vec4 a_color1;
layout(location = 4) in vec4 a_color2;
layout(location = 5) in vec4 a_params;

uniform vec4 u_zoom; // (zoomX, zoomY, zoomScale, logicalSize)

out vec2 v_local;
out vec2 v_uv;
flat out vec4 v_rotAlpha;
flat out vec4 v_color1;
flat out vec4 v_color2;
flat out vec4 v_params;
flat out vec2 v_halfSize;

void main() {
  vec2 corner = vec2(
    (gl_VertexID & 1) == 0 ? -1.0 : 1.0,
    (gl_VertexID & 2) == 0 ? -1.0 : 1.0
  );
  v_local = corner;
  v_uv = mix(a_uvRect.xy, a_uvRect.zw, corner * 0.5 + 0.5);
  v_rotAlpha = a_rotAlpha;
  v_color1 = a_color1;
  v_color2 = a_color2;
  v_params = a_params;
  v_halfSize = a_rect.zw;

  vec2 scaled = corner * a_rect.zw;
  vec2 rotated = vec2(
    scaled.x * a_rotAlpha.x - scaled.y * a_rotAlpha.y,
    scaled.x * a_rotAlpha.y + scaled.y * a_rotAlpha.x
  );
  vec2 logicalPos = a_rect.xy + rotated;

  float logicalSize = u_zoom.w;
  vec2 zoomed = (logicalPos - u_zoom.xy * logicalSize) * u_zoom.z + logicalSize * 0.5;
  vec2 ndc = vec2(
    (zoomed.x / logicalSize) * 2.0 - 1.0,
    1.0 - (zoomed.y / logicalSize) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_tex;

in vec2 v_local;
in vec2 v_uv;
flat in vec4 v_rotAlpha;
flat in vec4 v_color1;
flat in vec4 v_color2;
flat in vec4 v_params;
flat in vec2 v_halfSize;

out vec4 outColor;

vec4 premul(vec4 c) {
  return vec4(c.rgb * c.a, c.a);
}

void main() {
  float alpha = v_rotAlpha.z;
  int mode = int(v_rotAlpha.w + 0.5);

  if (mode == 0) {
    vec4 tex = texture(u_tex, v_uv);
    outColor = tex * v_color1 * alpha;
    return;
  }

  if (mode == 1) {
    float d = length(v_local);
    float aa = max(fwidth(d), 0.004);
    float rFill = v_params.x;
    float rStrokeIn = v_params.y;
    float rStrokeOut = v_params.z;

    float fillMask = 1.0 - smoothstep(rFill - aa, rFill + aa, d);
    vec4 res = premul(v_color1) * fillMask;

    if (rStrokeOut > rStrokeIn) {
      float strokeMask =
        smoothstep(rStrokeIn - aa, rStrokeIn + aa, d) *
        (1.0 - smoothstep(rStrokeOut - aa, rStrokeOut + aa, d));
      vec4 st = premul(v_color2) * strokeMask;
      res = st + res * (1.0 - st.a);
    }
    outColor = res * alpha;
    return;
  }

  if (mode == 2) {
    float d = length(v_local);
    float aa = max(fwidth(d), 0.004);
    float remaining = clamp(v_params.x, 0.0, 1.0);
    float sectorR = v_params.y;
    float arcIn = v_params.z;
    float arcOut = v_params.w;

    float ang = atan(v_local.y, v_local.x);
    float t = mod(ang + 1.57079632679 + 6.28318530718, 6.28318530718) / 6.28318530718;

    float sectorDisk = 1.0 - smoothstep(sectorR - aa, sectorR + aa, d);
    vec4 base = premul(vec4(1.0, 1.0, 1.0, 0.18)) * sectorDisk;
    if (remaining > 0.0) {
      float sectorActive = step(t, remaining) * sectorDisk;
      vec4 bright = premul(vec4(1.0, 1.0, 1.0, 0.42)) * sectorActive;
      base = bright + base * (1.0 - bright.a);

      float ringMask =
        smoothstep(arcIn - aa, arcIn + aa, d) *
        (1.0 - smoothstep(arcOut - aa, arcOut + aa, d));
      float endAng = -1.57079632679 + 6.28318530718 * remaining;
      float arcMid = 0.5 * (arcIn + arcOut);
      float arcHalf = 0.5 * (arcOut - arcIn);
      vec2 pStart = vec2(0.0, -arcMid);
      vec2 pEnd = vec2(cos(endAng), sin(endAng)) * arcMid;
      float capStart = 1.0 - smoothstep(arcHalf - aa, arcHalf + aa, length(v_local - pStart));
      float capEnd = 1.0 - smoothstep(arcHalf - aa, arcHalf + aa, length(v_local - pEnd));
      float arcMask = max(ringMask * step(t, remaining), max(capStart, capEnd));
      vec4 arcCol = premul(vec4(v_color2.rgb, 0.96)) * arcMask;
      base = arcCol + base * (1.0 - arcCol.a);
    }
    outColor = base * alpha;
    return;
  }

  if (mode == 3) {
    float d = length(v_local);
    float aa = max(fwidth(d), 0.004);
    float arcIn = v_params.x;
    float arcOut = v_params.y;
    float startA = v_params.z;
    float endA = v_params.w;

    float ang = mod(atan(v_local.y, v_local.x) + 6.28318530718, 6.28318530718);
    float inRange = step(startA, ang) * step(ang, endA);
    float ringMask =
      smoothstep(arcIn - aa, arcIn + aa, d) *
      (1.0 - smoothstep(arcOut - aa, arcOut + aa, d)) *
      inRange;
    float arcMid = 0.5 * (arcIn + arcOut);
    float arcHalf = 0.5 * (arcOut - arcIn);
    float cap1 = 1.0 - smoothstep(arcHalf - aa, arcHalf + aa, length(v_local - vec2(cos(startA), sin(startA)) * arcMid));
    float cap2 = 1.0 - smoothstep(arcHalf - aa, arcHalf + aa, length(v_local - vec2(cos(endA), sin(endA)) * arcMid));
    float mask = max(ringMask, max(cap1, cap2));
    outColor = premul(v_color1) * mask * alpha;
    return;
  }

  if (mode == 4) {
    // Triangle with vertices (1, 0), (-1, -1), (-1, 1)
    float e1 = v_local.x + 1.0;
    float e2 = (1.0 - v_local.x) - 2.0 * v_local.y;
    float e3 = (1.0 - v_local.x) + 2.0 * v_local.y;
    float dist = min(e1, min(e2, e3));
    float aa = max(fwidth(dist), 0.01);
    float mask = smoothstep(-aa, aa, dist);
    outColor = premul(v_color1) * mask * alpha;
    return;
  }

  if (mode == 5) {
    vec2 box = v_params.xy;
    vec2 d = abs(v_local) - box;
    float aa = max(fwidth(max(d.x, d.y)), 0.004);
    float mask = 1.0 - smoothstep(-aa, aa, max(d.x, d.y));
    float dashPeriod = v_params.z;
    if (dashPeriod > 0.0) {
      float segLen = v_halfSize.x * 2.0;
      float posAlong = (v_local.x * 0.5 + 0.5) * segLen + v_params.w;
      float phase = mod(posAlong, dashPeriod);
      float dashOn = 7.0;
      float dashMask = step(phase, dashOn);
      mask *= dashMask;
    }
    outColor = premul(v_color1) * mask * alpha;
    return;
  }

  // mode == 6: soft radial flame glow
  float d = length(v_local);
  float glow = exp(-d * d * 4.2) * (1.0 - smoothstep(0.68, 1.0, d));
  outColor = vec4(v_color1.rgb, v_color1.a * glow * alpha);
}
`;

export type RGBA = readonly [number, number, number, number];

const FLOATS_PER_INSTANCE = 24;
const INITIAL_CAPACITY = 512;

const colorCache = new Map<string, RGBA>();

export function parseCssColor(color: string): RGBA {
  const cached = colorCache.get(color);
  if (cached) return cached;

  let parsed: RGBA = [1, 1, 1, 1];
  const hex = color.trim();
  if (hex.startsWith('#')) {
    const raw = hex.slice(1);
    if (raw.length === 3 || raw.length === 4) {
      const r = parseInt(raw[0]! + raw[0]!, 16) / 255;
      const g = parseInt(raw[1]! + raw[1]!, 16) / 255;
      const b = parseInt(raw[2]! + raw[2]!, 16) / 255;
      const a = raw.length === 4 ? parseInt(raw[3]! + raw[3]!, 16) / 255 : 1;
      parsed = [r, g, b, a];
    } else if (raw.length === 6 || raw.length === 8) {
      const r = parseInt(raw.slice(0, 2), 16) / 255;
      const g = parseInt(raw.slice(2, 4), 16) / 255;
      const b = parseInt(raw.slice(4, 6), 16) / 255;
      const a = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
      parsed = [r, g, b, a];
    }
  } else {
    const m = hex.match(
      /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i,
    );
    if (m) {
      parsed = [
        Number(m[1]) / 255,
        Number(m[2]) / 255,
        Number(m[3]) / 255,
        m[4] !== undefined ? Number(m[4]) : 1,
      ];
    }
  }
  if (colorCache.size < 256) colorCache.set(color, parsed);
  return parsed;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export class WebGL2RadarRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly cache: RadarTextureCache;

  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private zoomUniform: WebGLUniformLocation | null = null;
  private texUniform: WebGLUniformLocation | null = null;

  private instances: Float32Array;
  private capacity: number;
  private count = 0;
  private drawCalls = 0;
  private frameInstances = 0;
  private currentTexture: WebGLTexture | null = null;
  private currentAdditive = false;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.cache = new RadarTextureCache(
      (canvas) => this.uploadTexture(canvas),
      (texture) => {
        if (!this.gl.isContextLost()) this.gl.deleteTexture(texture);
        if (this.currentTexture === texture) this.currentTexture = null;
      },
    );
    this.capacity = INITIAL_CAPACITY;
    this.instances = new Float32Array(this.capacity * FLOATS_PER_INSTANCE);
    this.initGl();
  }

  private uploadTexture(canvas: HTMLCanvasElement): WebGLTexture | null {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) return null;
    this.flush();
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.currentTexture = texture;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    return texture;
  }

  getLastFrameStats(): { readonly drawCalls: number; readonly instances: number } {
    return { drawCalls: this.drawCalls, instances: this.frameInstances };
  }

  initGl(): boolean {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    if (!vs || !fs) return false;

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return false;
    }

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) {
      gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (vbo) gl.deleteBuffer(vbo);
      return false;
    }

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.capacity * FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT,
      gl.DYNAMIC_DRAW,
    );

    const stride = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < 6; i += 1) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);

    this.program = program;
    this.vao = vao;
    this.instanceBuffer = vbo;
    this.zoomUniform = gl.getUniformLocation(program, 'u_zoom');
    this.texUniform = gl.getUniformLocation(program, 'u_tex');
    return true;
  }

  handleContextLost(): void {
    this.program = null;
    this.vao = null;
    this.instanceBuffer = null;
    this.zoomUniform = null;
    this.texUniform = null;
    this.currentTexture = null;
    this.count = 0;
  }

  handleContextRestored(): boolean {
    this.cache.clear();
    return this.initGl();
  }

  beginFrame(size: number, zoomX: number, zoomY: number, zoomScale: number): void {
    const gl = this.gl;
    if (this.disposed || !this.program || !this.vao || gl.isContextLost()) return;
    this.count = 0;
    this.drawCalls = 0;
    this.frameInstances = 0;
    this.currentTexture = null;
    this.currentAdditive = false;

    gl.viewport(0, 0, size, size);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const insetPx = Math.floor(
      (RADAR_CANVAS_GEOMETRY.inset / RADAR_CANVAS_GEOMETRY.logicalSize) * size,
    );
    const artPx = Math.ceil(
      (RADAR_CANVAS_GEOMETRY.artworkSize / RADAR_CANVAS_GEOMETRY.logicalSize) * size,
    );
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(insetPx, size - insetPx - artPx, artPx, artPx);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);
    gl.uniform4f(this.zoomUniform, zoomX, zoomY, zoomScale, RADAR_CANVAS_GEOMETRY.logicalSize);
    gl.uniform1i(this.texUniform, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
  }

  endFrame(): void {
    this.flush();
    this.gl.bindVertexArray(null);
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  private flush(): void {
    if (this.count === 0 || !this.instanceBuffer || this.gl.isContextLost()) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instances.subarray(0, this.count * FLOATS_PER_INSTANCE),
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.drawCalls += 1;
    this.frameInstances += this.count;
    this.count = 0;
  }

  private setBatchState(texture: WebGLTexture | null, additive: boolean): void {
    if (additive !== this.currentAdditive) {
      this.flush();
      this.currentAdditive = additive;
      this.gl.blendFunc(
        additive ? this.gl.SRC_ALPHA : this.gl.ONE,
        additive ? this.gl.ONE : this.gl.ONE_MINUS_SRC_ALPHA,
      );
    }
    if (texture !== null && texture !== this.currentTexture) {
      this.flush();
      this.currentTexture = texture;
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    }
  }

  private pushInstance(
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    cosA: number,
    sinA: number,
    alpha: number,
    mode: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    c1: RGBA,
    c2: RGBA,
    p0: number,
    p1: number,
    p2: number,
    p3: number,
  ): void {
    if (this.count >= this.capacity) {
      const nextCapacity = this.capacity * 2;
      const next = new Float32Array(nextCapacity * FLOATS_PER_INSTANCE);
      next.set(this.instances);
      this.instances = next;
      this.capacity = nextCapacity;
      if (this.instanceBuffer && !this.gl.isContextLost()) {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
        this.gl.bufferData(
          this.gl.ARRAY_BUFFER,
          this.capacity * FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT,
          this.gl.DYNAMIC_DRAW,
        );
      }
    }
    const base = this.count * FLOATS_PER_INSTANCE;
    const buf = this.instances;
    buf[base] = cx;
    buf[base + 1] = cy;
    buf[base + 2] = halfW;
    buf[base + 3] = halfH;
    buf[base + 4] = cosA;
    buf[base + 5] = sinA;
    buf[base + 6] = alpha;
    buf[base + 7] = mode;
    buf[base + 8] = u0;
    buf[base + 9] = v0;
    buf[base + 10] = u1;
    buf[base + 11] = v1;
    buf[base + 12] = c1[0];
    buf[base + 13] = c1[1];
    buf[base + 14] = c1[2];
    buf[base + 15] = c1[3];
    buf[base + 16] = c2[0];
    buf[base + 17] = c2[1];
    buf[base + 18] = c2[2];
    buf[base + 19] = c2[3];
    buf[base + 20] = p0;
    buf[base + 21] = p1;
    buf[base + 22] = p2;
    buf[base + 23] = p3;
    this.count += 1;
  }

  drawTexturedQuad(
    region: TextureRegion,
    cx: number,
    cy: number,
    width: number,
    height: number,
    alpha = 1,
    angleRad = 0,
    tint: RGBA = [1, 1, 1, 1],
  ): void {
    this.setBatchState(region.texture, false);
    const cosA = angleRad === 0 ? 1 : Math.cos(angleRad);
    const sinA = angleRad === 0 ? 0 : Math.sin(angleRad);
    this.pushInstance(
      cx,
      cy,
      width * 0.5,
      height * 0.5,
      cosA,
      sinA,
      alpha,
      0,
      region.u0,
      region.v0,
      region.u1,
      region.v1,
      tint,
      [0, 0, 0, 0],
      0,
      0,
      0,
      0,
    );
  }

  drawCircle(
    cx: number,
    cy: number,
    radius: number,
    fill: string,
    alpha = 1,
    stroke?: string,
    strokeWidth = 4,
    additive = false,
  ): void {
    this.setBatchState(null, additive);
    const hasStroke = stroke !== undefined && strokeWidth > 0;
    const halfW = radius + (hasStroke ? strokeWidth * 0.5 : 0) + 1.5;
    const rFill = radius / halfW;
    const rStrokeIn = hasStroke ? Math.max(0, radius - strokeWidth * 0.5) / halfW : 0;
    const rStrokeOut = hasStroke ? (radius + strokeWidth * 0.5) / halfW : 0;
    this.pushInstance(
      cx,
      cy,
      halfW,
      halfW,
      1,
      0,
      alpha,
      1,
      0,
      0,
      1,
      1,
      parseCssColor(fill),
      hasStroke ? parseCssColor(stroke) : [0, 0, 0, 0],
      rFill,
      rStrokeIn,
      rStrokeOut,
      0,
    );
  }

  drawSmokeTimer(
    cx: number,
    cy: number,
    timerRadius: number,
    remainingRatio: number,
    sideColor: string,
    alpha: number,
  ): void {
    this.setBatchState(null, false);
    const strokeWidth = 9;
    const halfW = timerRadius + strokeWidth * 0.5 + 1.5;
    const sectorR = Math.max(0, timerRadius - 3) / halfW;
    const arcIn = Math.max(0, timerRadius - strokeWidth * 0.5) / halfW;
    const arcOut = (timerRadius + strokeWidth * 0.5) / halfW;
    this.pushInstance(
      cx,
      cy,
      halfW,
      halfW,
      1,
      0,
      alpha,
      2,
      0,
      0,
      1,
      1,
      [1, 1, 1, 1],
      parseCssColor(sideColor),
      remainingRatio,
      sectorR,
      arcIn,
      arcOut,
    );
  }

  drawDamageArc(cx: number, cy: number, radius: number, angleRad: number, alpha: number): void {
    this.setBatchState(null, false);
    const strokeWidth = 5;
    const halfW = radius + strokeWidth * 0.5 + 1.5;
    const arcIn = Math.max(0, radius - strokeWidth * 0.5) / halfW;
    const arcOut = (radius + strokeWidth * 0.5) / halfW;
    this.pushInstance(
      cx,
      cy,
      halfW,
      halfW,
      Math.cos(angleRad),
      Math.sin(angleRad),
      alpha,
      3,
      0,
      0,
      1,
      1,
      parseCssColor('#ff6c69'),
      [0, 0, 0, 0],
      arcIn,
      arcOut,
      Math.PI * 0.72,
      Math.PI * 1.28,
    );
  }

  drawFacingArrow(cx: number, cy: number, angleRad: number, color: string, alpha: number): void {
    this.setBatchState(null, false);
    // Triangle from x=18..41, y=-12..12 in rotated local space: center=(29.5, 0), halfW=11.5, halfH=12
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    const localCx = 29.5;
    this.pushInstance(
      cx + localCx * cosA,
      cy + localCx * sinA,
      11.5,
      12,
      cosA,
      sinA,
      alpha,
      4,
      0,
      0,
      1,
      1,
      parseCssColor(color),
      [0, 0, 0, 0],
      0,
      0,
      0,
      0,
    );
  }

  drawRect(
    cx: number,
    cy: number,
    width: number,
    height: number,
    color: string,
    alpha = 1,
    angleRad = 0,
    dashPeriod = 0,
    dashOffset = 0,
  ): void {
    this.setBatchState(null, false);
    const hw = width * 0.5 + 1;
    const hh = height * 0.5 + 1;
    const cosA = angleRad === 0 ? 1 : Math.cos(angleRad);
    const sinA = angleRad === 0 ? 0 : Math.sin(angleRad);
    this.pushInstance(
      cx,
      cy,
      hw,
      hh,
      cosA,
      sinA,
      alpha,
      5,
      0,
      0,
      1,
      1,
      parseCssColor(color),
      [0, 0, 0, 0],
      (width * 0.5) / hw,
      (height * 0.5) / hh,
      dashPeriod,
      dashOffset,
    );
  }

  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    color: string,
    alpha = 1,
    dashPeriod = 0,
    dashOffset = 0,
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    this.drawRect(
      (x1 + x2) * 0.5,
      (y1 + y2) * 0.5,
      len,
      width,
      color,
      alpha,
      Math.atan2(dy, dx),
      dashPeriod,
      dashOffset,
    );
  }

  drawFlameGlow(cx: number, cy: number, radius: number, color: string, alpha: number): void {
    this.setBatchState(null, true);
    const glowR = radius * 1.95;
    this.pushInstance(
      cx,
      cy,
      glowR,
      glowR,
      1,
      0,
      alpha,
      6,
      0,
      0,
      1,
      1,
      parseCssColor(color),
      [0, 0, 0, 0],
      0,
      0,
      0,
      0,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.cache.clear();
    if (!gl.isContextLost()) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
    }
    this.program = null;
    this.vao = null;
    this.instanceBuffer = null;
  }
}
