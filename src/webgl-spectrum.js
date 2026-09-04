const BG = [0.02, 0.024, 0.031];
const GRID = [0.1, 0.125, 0.188];
const LINE = [0.31, 0.66, 1.0];
const FILL_TOP = [0.31, 0.66, 1.0, 0.28];
const CENTER = [0.88, 0.32, 0.32];
const BW_FILL = [0.83, 0.63, 0.09, 0.14];
const BW_EDGE = [0.83, 0.63, 0.09, 0.4];
const HANDLE = [0.83, 0.63, 0.09, 0.55];

const VS = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS_COLOR = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    throw new Error(gl.getShaderInfoLog(sh) || "shader error");
  }
  return sh;
}

function sliceBins(bins, specZoom) {
  const n = bins.length;
  if (n < 2 || specZoom <= 1) return bins;
  const half = n / (2 * specZoom);
  const c = n / 2;
  const s = Math.max(0, Math.floor(c - half));
  const e = Math.min(n, Math.ceil(c + half));
  return bins.subarray(s, e);
}

/** Upsample zoomed slice so the GL curve isn't blocky. */
function resampleView(view, outLen) {
  const n = view.length;
  if (n < 2 || outLen <= n) return view;
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const t = (i / (outLen - 1)) * (n - 1);
    const i0 = Math.floor(t);
    const f = t - i0;
    const a = view[i0];
    const b = view[Math.min(n - 1, i0 + 1)];
    out[i] = a * (1 - f) + b * f;
  }
  return out;
}

function dbToNdc(db, specRange, specOffset) {
  const top = specOffset;
  const bottom = specOffset - specRange;
  const clamped = Math.max(bottom, Math.min(top, db));
  return ((clamped - bottom) / (top - bottom)) * 2 - 1;
}

/** WebGL spectrum: grid, bandwidth shade, filled curve, line. */
export class WebGLSpectrum {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.w = 0;
    this.h = 0;

    const gl =
      canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        depth: false,
        premultipliedAlpha: false,
      }) || canvas.getContext("experimental-webgl");
    if (!gl) return;

    try {
      this.gl = gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FS_COLOR));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link failed");
      this.prog = prog;
      this.aPos = gl.getAttribLocation(prog, "a_pos");
      this.uColor = gl.getUniformLocation(prog, "u_color");
      this.buf = gl.createBuffer();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.ok = true;
    } catch {
      this.ok = false;
    }
  }

  resize(w, h) {
    if (!this.ok) return;
    this.w = w;
    this.h = h;
    this.gl.viewport(0, 0, w, h);
  }

  drawLines(gl, pairs, color) {
    if (pairs.length < 4) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, pairs, gl.STATIC_DRAW);
    gl.useProgram(this.prog);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(this.uColor, color);
    gl.drawArrays(gl.LINES, 0, pairs.length / 2);
  }

  drawTriStrip(gl, verts, color) {
    if (verts.length < 6) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.useProgram(this.prog);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(this.uColor, color);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, verts.length / 2);
  }

  drawLineStrip(gl, verts, color) {
    if (verts.length < 4) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.useProgram(this.prog);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(this.uColor, color);
    gl.drawArrays(gl.LINE_STRIP, 0, verts.length / 2);
  }

  drawGrid(gl) {
    const v = [];
    for (let i = 1; i < 8; i++) {
      const x = -1 + (2 * i) / 8;
      v.push(x, -1, x, 1);
    }
    for (let i = 1; i < 5; i++) {
      const y = -1 + (2 * i) / 5;
      v.push(-1, y, 1, y);
    }
    this.drawLines(gl, new Float32Array(v), [...GRID, 1]);
  }

  drawBandwidth(gl, sampleRateHz, specZoom, bandwidthHz, tuneNdc = 0) {
    if (!bandwidthHz || !sampleRateHz) return;
    const span = sampleRateHz / specZoom;
    const bw = Math.min(bandwidthHz, span);
    const halfNdc = bw / span;
    const x1 = tuneNdc - halfNdc;
    const x2 = tuneNdc + halfNdc;
    const verts = new Float32Array([x1, -1, x2, -1, x1, 1, x2, 1]);
    this.drawTriStrip(gl, verts, BW_FILL);
    const edges = new Float32Array([
      x1, -1, x1, 1,
      x2, -1, x2, 1,
    ]);
    this.drawLines(gl, edges, BW_EDGE);
    const hw = Math.max(0.004, 8 / this.w);
    const hh = Math.min(0.22, 56 / this.h);
    for (const x of [x1, x2]) {
      this.drawTriStrip(
        gl,
        new Float32Array([x - hw, -hh, x + hw, -hh, x - hw, hh, x + hw, hh]),
        HANDLE,
      );
    }
  }

  draw({ bins, sampleRateHz, specZoom, specRange, specOffset, bandwidthHz, panOffsetHz = 0 }) {
    if (!this.ok || !bins?.length) return;
    const gl = this.gl;
    const sliced = sliceBins(bins, specZoom);
    const target = Math.min(Math.max(this.w, 512), 4096);
    const view = resampleView(sliced, target);
    const n = view.length;
    if (n < 2) return;

    const span = sampleRateHz / specZoom;
    const panNdc = span > 0 ? (-2 * panOffsetHz) / span : 0;
    const tuneNdc = panNdc;

    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawGrid(gl);
    this.drawBandwidth(gl, sampleRateHz, specZoom, bandwidthHz, tuneNdc);

    const line = new Float32Array(n * 2);
    const fill = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = -1 + (2 * i) / (n - 1) + panNdc;
      const y = dbToNdc(view[i], specRange, specOffset);
      line[i * 2] = x;
      line[i * 2 + 1] = y;
      fill[i * 4] = x;
      fill[i * 4 + 1] = y;
      fill[i * 4 + 2] = x;
      fill[i * 4 + 3] = -1;
    }

    this.drawTriStrip(gl, fill, FILL_TOP);
    gl.lineWidth = Math.max(1, this.w / 800);
    this.drawLineStrip(gl, line, [...LINE, 1]);

    const cx = tuneNdc;
    this.drawLines(gl, new Float32Array([cx, -1, cx, 1]), [...CENTER, 1]);
  }

  clear() {
    if (!this.ok) return;
    const gl = this.gl;
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawGrid(gl);
  }
}
