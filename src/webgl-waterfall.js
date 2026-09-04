const PALETTE_STOPS = [
  [0, 0, 8],
  [0, 0, 48],
  [0, 24, 96],
  [0, 80, 140],
  [0, 140, 140],
  [20, 170, 60],
  [120, 200, 20],
  [220, 210, 0],
  [255, 140, 0],
  [255, 40, 0],
  [255, 255, 220],
];

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_data;
uniform float u_head;
uniform float u_texH;

void main() {
  if (u_texH < 1.0) {
    gl_FragColor = vec4(0.02, 0.024, 0.031, 1.0);
    return;
  }
  float yFromBottom = min(floor(v_uv.y * u_texH), u_texH - 1.0);
  float row = mod(u_head - yFromBottom + u_texH, u_texH);
  float v = (row + 0.5) / u_texH;
  gl_FragColor = texture2D(u_data, vec2(v_uv.x, v));
}
`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log || "shader compile failed");
  }
  return sh;
}

function dbToRgb(db, contrast, topDb = 0, rangeDb = 100) {
  const span = rangeDb / Math.max(0.35, contrast / 50);
  const bottom = topDb - span;
  const t = Math.max(0, Math.min(1, (db - bottom) / Math.max(1e-6, topDb - bottom)));
  const n = PALETTE_STOPS.length - 1;
  const idx = t * n;
  const i0 = Math.floor(idx);
  const i1 = Math.min(n, i0 + 1);
  const f = idx - i0;
  const a = PALETTE_STOPS[i0];
  const b = PALETTE_STOPS[i1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** GPU ring-buffer waterfall — one RGBA row upload per scroll step. */
export class WebGLWaterfall {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.head = 0;
    this.texW = 0;
    this.texH = 0;
    this.rowBuf = null;
    this.contrast = 50;
    this.topDb = 0;
    this.rangeDb = 100;
    this.failed = false;

    const gl =
      canvas.getContext("webgl", {
        antialias: false,
        alpha: true,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) || canvas.getContext("experimental-webgl");

    if (!gl) return;

    try {
      this.gl = gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || "link failed");
      }
      this.prog = prog;

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.buf = buf;

      this.aPos = gl.getAttribLocation(prog, "a_pos");
      this.uData = gl.getUniformLocation(prog, "u_data");
      this.uHead = gl.getUniformLocation(prog, "u_head");
      this.uTexH = gl.getUniformLocation(prog, "u_texH");

      this.dataTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.ok = true;
      this.selfTest();
    } catch {
      this.ok = false;
    }
  }

  selfTest() {
    const prevW = this.texW;
    const prevH = this.texH;
    this.resize(8, 8);
    const ok = this.pushRow(new Array(16).fill(-25));
    this.head = 0;
    this.texW = prevW;
    this.texH = prevH;
    this.rowBuf = null;
    if (!ok) {
      this.ok = false;
      this.failed = true;
    }
  }

  setContrast(n) {
    this.contrast = n;
  }

  setDbScale(topDb, rangeDb) {
    this.topDb = topDb;
    this.rangeDb = rangeDb;
  }

  resize(w, h) {
    if (!this.ok || w < 1 || h < 1) return;
    if (w === this.texW && h === this.texH) return;

    const gl = this.gl;
    this.texW = w;
    this.texH = h;
    this.head = 0;
    this.rowBuf = new Uint8Array(w * 4);

    gl.viewport(0, 0, w, h);
    this.fillTexture(5, 6, 8);
  }

  fillTexture(r, g, b) {
    const gl = this.gl;
    const pixels = new Uint8Array(this.texW * this.texH * 4);
    for (let i = 0; i < this.texW * this.texH; i++) {
      pixels[i * 4] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.texW, this.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }

  pushRow(bins, panFrac = 0) {
    if (!this.ok || this.failed || !this.rowBuf || this.texW < 1 || this.texH < 1) return false;

    const gl = this.gl;
    const row = this.rowBuf;
    const n = bins.length;
    const w = this.texW;
    if (n < 2) return false;

    for (let x = 0; x < w; x++) {
      const rel = x / (w - 1) - 0.5 - panFrac;
      const t = (rel + 0.5) * (n - 1);
      const i0 = Math.floor(t);
      const f = t - i0;
      const a = bins[Math.max(0, Math.min(n - 1, i0))] ?? -100;
      const b = bins[Math.max(0, Math.min(n - 1, i0 + 1))] ?? a;
      const db = a * (1 - f) + b * f;
      const [r, g, bch] = dbToRgb(db, this.contrast, this.topDb, this.rangeDb);
      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = bch;
      row[x * 4 + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.head, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);

    if (gl.getError() !== gl.NO_ERROR) {
      this.failed = true;
      this.ok = false;
      return false;
    }

    this.head = (this.head + 1) % this.texH;
    return true;
  }

  scroll(bins, speed) {
    if (!this.ok || this.texW < 1 || this.texH < 1) return false;

    const steps = Math.max(1, speed | 0);
    for (let i = 0; i < steps; i++) {
      if (!this.pushRow(bins)) return false;
    }
    this.draw();
    return true;
  }

  draw() {
    if (!this.ok || this.texH < 1) return;

    const gl = this.gl;
    const newest = (this.head - 1 + this.texH) % this.texH;

    gl.viewport(0, 0, this.texW, this.texH);
    gl.clearColor(0.02, 0.024, 0.031, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.uniform1i(this.uData, 0);
    gl.uniform1f(this.uHead, newest);
    gl.uniform1f(this.uTexH, this.texH);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear() {
    if (!this.ok || this.texW < 1 || this.texH < 1) return;
    this.head = 0;
    this.fillTexture(5, 6, 8);
    this.draw();
  }
}
