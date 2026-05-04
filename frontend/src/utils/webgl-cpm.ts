/* WebGL 2.0 CPM Engine - вычисление критического пути через max-plus матричное умножение
 * на GPU с фрагментными шейдерами */

const MAX_N = 4096;
const NO_REL = -1e15;

export interface CPMRelation {
  predIdx: number;
  succIdx: number;
  // 0=FS, 1=SS, 2=FF, 3=SF
  type: number;
  lag: number;
}

export interface CPMInput {
  n: number;
  durations: Float32Array;
  relations: CPMRelation[];
  hardStarts: Float32Array; // NaN = не задан
}

export interface CPMResult {
  es: Float32Array;
  ef: Float32Array;
  ls: Float32Array;
  lf: Float32Array;
  tf: Float32Array;
  ff: Float32Array;
  critical: Uint8Array;
}

const VERT_SRC = `#version 300 es
void main() {
  vec2 p;
  if (gl_VertexID == 0) p = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) p = vec2(3.0, -1.0);
  else p = vec2(-1.0, 3.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FWD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uES;
uniform sampler2D uDur;
uniform sampler2D uLag;
uniform sampler2D uType;
uniform sampler2D uHS;
uniform float uN;
out vec4 fragColor;
const int MX = ${MAX_N};
void main() {
  int j = int(gl_FragCoord.x);
  vec4 hs = texelFetch(uHS, ivec2(j, 0), 0);
  if (hs.g > 0.5) { fragColor = vec4(max(hs.r, 0.0), 0.0, 0.0, 1.0); return; }
  float best = max(texelFetch(uES, ivec2(j, 0), 0).r, 0.0);
  float dj = texelFetch(uDur, ivec2(j, 0), 0).r;
  for (int i = 0; i < MX; i++) {
    if (float(i) >= uN) break;
    float lag = texelFetch(uLag, ivec2(j, i), 0).r;
    if (lag < -9e14) continue;
    float rt = texelFetch(uType, ivec2(j, i), 0).r;
    float ei = texelFetch(uES, ivec2(i, 0), 0).r;
    float di = texelFetch(uDur, ivec2(i, 0), 0).r;
    float c;
    if (rt < 0.5) c = ei + di + lag;
    else if (rt < 1.5) c = ei + lag;
    else if (rt < 2.5) c = ei + di + lag - dj;
    else c = ei + lag - dj;
    if (c > best) best = c;
  }
  fragColor = vec4(best, 0.0, 0.0, 1.0);
}`;

const BWD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uLF;
uniform sampler2D uDur;
uniform sampler2D uLag;
uniform sampler2D uType;
uniform float uN;
out vec4 fragColor;
const int MX = ${MAX_N};
void main() {
  int i = int(gl_FragCoord.x);
  float best = texelFetch(uLF, ivec2(i, 0), 0).r;
  float di = texelFetch(uDur, ivec2(i, 0), 0).r;
  for (int j = 0; j < MX; j++) {
    if (float(j) >= uN) break;
    float lag = texelFetch(uLag, ivec2(j, i), 0).r;
    if (lag < -9e14) continue;
    float rt = texelFetch(uType, ivec2(j, i), 0).r;
    float lfj = texelFetch(uLF, ivec2(j, 0), 0).r;
    float dj = texelFetch(uDur, ivec2(j, 0), 0).r;
    float c;
    if (rt < 0.5) c = lfj - dj - lag;
    else if (rt < 1.5) c = lfj - dj - lag + di;
    else if (rt < 2.5) c = lfj - lag;
    else c = lfj - lag + di;
    if (c < best) best = c;
  }
  fragColor = vec4(best, 0.0, 0.0, 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, src: string, type: number): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null {
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('Link error:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

export class WebglCPM {
  private gl: WebGL2RenderingContext;
  private fwdProg: WebGLProgram;
  private bwdProg: WebGLProgram;
  // private vao: WebGLVertexArrayObject;

  constructor() {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    gl.getExtension('EXT_color_buffer_float');
    this.gl = gl;

    const vs = compileShader(gl, VERT_SRC, gl.VERTEX_SHADER)!;
    const fwdFs = compileShader(gl, FWD_FRAG, gl.FRAGMENT_SHADER)!;
    const bwdFs = compileShader(gl, BWD_FRAG, gl.FRAGMENT_SHADER)!;
    this.fwdProg = linkProgram(gl, vs, fwdFs)!;
    this.bwdProg = linkProgram(gl, vs, bwdFs)!;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    // this.vao = vao;
  }

  private makeTex(data: Float32Array, w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private makeFB(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fb;
  }

  private pad1(arr: Float32Array, n: number): Float32Array {
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) out[i * 4] = arr[i];
    return out;
  }

  private pad2(arr: Float32Array, n: number): Float32Array {
    const out = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) out[i * 4] = arr[i];
    return out;
  }

  compute(input: CPMInput): CPMResult {
    const gl = this.gl;
    const { n, durations, relations, hardStarts } = input;
    const lag = new Float32Array(n * n).fill(NO_REL);
    const rtype = new Float32Array(n * n).fill(-1.0);
    for (const r of relations) {
      lag[r.predIdx * n + r.succIdx] = r.lag;
      rtype[r.predIdx * n + r.succIdx] = r.type;
    }
    const durTex = this.makeTex(this.pad1(durations, n), n, 1);
    const lagTex = this.makeTex(this.pad2(lag, n), n, n);
    const typTex = this.makeTex(this.pad2(rtype, n), n, n);
    const hsData = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (hardStarts[i] === hardStarts[i]) {
        hsData[i * 4] = hardStarts[i];
        hsData[i * 4 + 1] = 1.0;
      }
    }
    const hsTex = this.makeTex(hsData, n, 1);

    // Инициализация ES
    const esInit = new Float32Array(n);
    for (let i = 0; i < n; i++) esInit[i] = hardStarts[i] === hardStarts[i] ? hardStarts[i] : 0;
    const esTexA = this.makeTex(this.pad1(esInit, n), n, 1);
    const esTexB = this.makeTex(this.pad1(esInit, n), n, 1);
    const fbA = this.makeFB(esTexA);
    const fbB = this.makeFB(esTexB);

    // Прямой проход - N итераций
    gl.useProgram(this.fwdProg);
    gl.uniform1f(gl.getUniformLocation(this.fwdProg, 'uN'), n);
    gl.uniform1i(gl.getUniformLocation(this.fwdProg, 'uES'), 0);
    gl.uniform1i(gl.getUniformLocation(this.fwdProg, 'uDur'), 1);
    gl.uniform1i(gl.getUniformLocation(this.fwdProg, 'uLag'), 2);
    gl.uniform1i(gl.getUniformLocation(this.fwdProg, 'uType'), 3);
    gl.uniform1i(gl.getUniformLocation(this.fwdProg, 'uHS'), 4);

    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, durTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lagTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, typTex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, hsTex);

    let rTex = esTexA, wTex = esTexB, rFb = fbA, wFb = fbB;
    for (let it = 0; it < n; it++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rTex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, wFb);
      gl.viewport(0, 0, n, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [rTex, wTex] = [wTex, rTex];
      [rFb, wFb] = [wFb, rFb];
    }

    // Читаем ES
    gl.bindFramebuffer(gl.FRAMEBUFFER, rFb);
    const esPx = new Float32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, esPx);
    const es = new Float32Array(n);
    for (let i = 0; i < n; i++) es[i] = esPx[i * 4];

    // EF = ES + D
    const ef = new Float32Array(n);
    for (let i = 0; i < n; i++) ef[i] = es[i] + durations[i];

    // Инициализация LF = max(EF)
    let projEnd = 0;
    for (let i = 0; i < n; i++) if (ef[i] > projEnd) projEnd = ef[i];
    const lfInit = new Float32Array(n).fill(projEnd);
    const lfTexA = this.makeTex(this.pad1(lfInit, n), n, 1);
    const lfTexB = this.makeTex(this.pad1(lfInit, n), n, 1);
    const lfFbA = this.makeFB(lfTexA);
    const lfFbB = this.makeFB(lfTexB);

    // Обратный проход - N итераций
    gl.useProgram(this.bwdProg);
    gl.uniform1f(gl.getUniformLocation(this.bwdProg, 'uN'), n);
    gl.uniform1i(gl.getUniformLocation(this.bwdProg, 'uLF'), 0);
    gl.uniform1i(gl.getUniformLocation(this.bwdProg, 'uDur'), 1);
    gl.uniform1i(gl.getUniformLocation(this.bwdProg, 'uLag'), 2);
    gl.uniform1i(gl.getUniformLocation(this.bwdProg, 'uType'), 3);
    // durTex, lagTex, typTex уже привязаны к 1, 2, 3

    rTex = lfTexA; wTex = lfTexB; rFb = lfFbA; wFb = lfFbB;
    for (let it = 0; it < n; it++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rTex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, wFb);
      gl.viewport(0, 0, n, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [rTex, wTex] = [wTex, rTex];
      [rFb, wFb] = [wFb, rFb];
    }

    // Читаем LF
    gl.bindFramebuffer(gl.FRAMEBUFFER, rFb);
    const lfPx = new Float32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, lfPx);
    const lf = new Float32Array(n);
    for (let i = 0; i < n; i++) lf[i] = lfPx[i * 4];

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // LS, TF, FF, critical - на CPU (вторичные метрики)
    const ls = new Float32Array(n);
    const tf = new Float32Array(n);
    const ff = new Float32Array(n);
    const critical = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      ls[i] = lf[i] - durations[i];
      tf[i] = ls[i] - es[i];
    }

    for (let i = 0; i < n; i++) {
      let minFF = tf[i];
      for (const r of relations) {
        if (r.predIdx !== i) continue;
        const j = r.succIdx;
        let cand: number;
        if (r.type === 0) cand = es[i] + durations[i] + r.lag;
        else if (r.type === 1) cand = es[i] + r.lag;
        else if (r.type === 2) cand = es[i] + durations[i] + r.lag;
        else cand = es[i] + r.lag;
        const freeF = es[j] - cand;
        if (freeF < minFF) minFF = freeF;
      }
      ff[i] = Math.max(0, minFF);
      critical[i] = tf[i] < 0.01 ? 1 : 0;
    }

    return { es, ef, ls, lf, tf, ff, critical };
  }

  // Вычислить нагрузку ресурсов по дням (CPU)
  static computeResourceLoad(
    n: number,
    es: Float32Array,
    durations: Float32Array,
    assignments: Array<{ actIdx: number; resIdx: number; units: number }>,
    resCount: number,
    totalDays: number,
  ): Float32Array[] {
    if (n) {};
    const loads: Float32Array[] = [];
    for (let r = 0; r < resCount; r++) loads.push(new Float32Array(totalDays));
    for (const a of assignments) {
      const start = Math.floor(es[a.actIdx]);
      const end = Math.ceil(es[a.actIdx] + durations[a.actIdx]);
      for (let d = start; d < end && d < totalDays; d++) {
        if (d >= 0) loads[a.resIdx][d] += a.units;
      }
    }
    return loads;
  }
}

// CPU-запасной CPM, если WebGL недоступен
export function cpmCPU(input: CPMInput): CPMResult {
  const { n, durations, relations, hardStarts } = input;
  const es = new Float32Array(n);
  const ef = new Float32Array(n);
  const ls = new Float32Array(n);
  const lf = new Float32Array(n);
  const tf = new Float32Array(n);
  const ff = new Float32Array(n);
  const critical = new Uint8Array(n);

  for (let i = 0; i < n; i++) es[i] = hardStarts[i] === hardStarts[i] ? hardStarts[i] : 0;

  // Прямой проход
  for (let it = 0; it < n; it++) {
    let changed = false;
    for (const r of relations) {
      const ei = es[r.predIdx];
      const di = durations[r.predIdx];
      const dj = durations[r.succIdx];
      let cand: number;
      if (r.type === 0) cand = ei + di + r.lag;
      else if (r.type === 1) cand = ei + r.lag;
      else if (r.type === 2) cand = ei + di + r.lag - dj;
      else cand = ei + r.lag - dj;
      if (cand > es[r.succIdx]) { es[r.succIdx] = cand; changed = true; }
    }
    if (!changed) break;
  }

  for (let i = 0; i < n; i++) ef[i] = es[i] + durations[i];

  let projEnd = 0;
  for (let i = 0; i < n; i++) if (ef[i] > projEnd) projEnd = ef[i];
  for (let i = 0; i < n; i++) lf[i] = projEnd;

  // Обратный проход
  for (let it = 0; it < n; it++) {
    let changed = false;
    for (const r of relations) {
      const lfj = lf[r.succIdx];
      const dj = durations[r.succIdx];
      const di = durations[r.predIdx];
      let cand: number;
      if (r.type === 0) cand = lfj - dj - r.lag;
      else if (r.type === 1) cand = lfj - dj - r.lag + di;
      else if (r.type === 2) cand = lfj - r.lag;
      else cand = lfj - r.lag + di;
      if (cand < lf[r.predIdx]) { lf[r.predIdx] = cand; changed = true; }
    }
    if (!changed) break;
  }

  for (let i = 0; i < n; i++) {
    ls[i] = lf[i] - durations[i];
    tf[i] = ls[i] - es[i];
  }

  for (let i = 0; i < n; i++) {
    let minFF = tf[i];
    for (const r of relations) {
      if (r.predIdx !== i) continue;
      const j = r.succIdx;
      let cand: number;
      if (r.type === 0) cand = es[i] + durations[i] + r.lag;
      else if (r.type === 1) cand = es[i] + r.lag;
      else if (r.type === 2) cand = es[i] + durations[i] + r.lag;
      else cand = es[i] + r.lag;
      const freeF = es[j] - cand;
      if (freeF < minFF) minFF = freeF;
    }
    ff[i] = Math.max(0, minFF);
    critical[i] = tf[i] < 0.01 ? 1 : 0;
  }

  return { es, ef, ls, lf, tf, ff, critical };
}

// Эвристическое выравнивание ресурсов
export function levelResourcesHeuristic(
  n: number,
  durations: Float32Array,
  es: Float32Array,
  tf: Float32Array,
  assignments: Array<{ actIdx: number; resIdx: number; units: number }>,
  resMax: Float32Array,
  resCount: number,
  totalDays: number,
  maxIter: number = 200,
): Float32Array {
  const delays = new Float32Array(n);
  const loads = WebglCPM.computeResourceLoad(n, es, durations, assignments, resCount, totalDays);

  for (let iter = 0; iter < maxIter; iter++) {
    let worstOver = 0;
    let worstDay = -1;
    let worstRes = -1;

    for (let r = 0; r < resCount; r++) {
      for (let d = 0; d < totalDays; d++) {
        const over = loads[r][d] - resMax[r];
        if (over > worstOver) { worstOver = over; worstDay = d; worstRes = r; }
      }
    }

    if (worstOver <= 0.01) break;

    // Найти работу на этом ресурсе с наибольшим резервом
    const cands = assignments
      .filter(a => a.resIdx === worstRes)
      .map(a => {
        const start = Math.floor(es[a.actIdx] + delays[a.actIdx]);
        const end = Math.ceil(es[a.actIdx] + delays[a.actIdx] + durations[a.actIdx]);
        const active = start <= worstDay && worstDay < end;
        const remainFloat = tf[a.actIdx] - delays[a.actIdx];
        return { actIdx: a.actIdx, units: a.units, active, remainFloat };
      })
      .filter(c => c.active && c.remainFloat > 0.5)
      .sort((a, b) => b.remainFloat - a.remainFloat);

    if (cands.length === 0) break;

    const target = cands[0];
    const shiftDays = Math.min(Math.ceil(worstOver / target.units), Math.floor(target.remainFloat));
    if (shiftDays < 1) break;

    // Обновить нагрузку
    const oldStart = Math.floor(es[target.actIdx] + delays[target.actIdx]);
    const oldEnd = Math.ceil(es[target.actIdx] + delays[target.actIdx] + durations[target.actIdx]);
    for (let d = oldStart; d < oldEnd && d < totalDays; d++) {
      if (d >= 0) loads[worstRes][d] -= target.units;
    }
    delays[target.actIdx] += shiftDays;
    const newStart = Math.floor(es[target.actIdx] + delays[target.actIdx]);
    const newEnd = Math.ceil(es[target.actIdx] + delays[target.actIdx] + durations[target.actIdx]);
    for (let d = newStart; d < newEnd && d < totalDays; d++) {
      if (d >= 0) loads[worstRes][d] += target.units;
    }
  }

  return delays;
}