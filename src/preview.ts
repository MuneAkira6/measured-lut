// Before/after preview in WebGL2: the photo is one 2D texture, the LUT is a 3D
// texture, and the GPU's trilinear filtering does the lookup.

import { SRGB_TO_P3 } from "./color";
import type { RgbSpace } from "./color";
import type { Lut } from "./lut";

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 color;
uniform sampler2D photo;
uniform sampler3D lut;
uniform float lutSize;
uniform bool hasLut;
uniform bool srgbInput;
uniform mat3 srgbToP3;
uniform float split;

vec3 decode(vec3 v) { return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(0.04045, v)); }
vec3 encode(vec3 v) { return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, v)); }

void main() {
  vec3 c = texture(photo, uv).rgb;
  if (srgbInput) c = encode(clamp(srgbToP3 * decode(c), 0.0, 1.0));
  if (hasLut && uv.x > split) {
    // Map 0..1 onto the centres of the first and last texels.
    c = texture(lut, c * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize).rgb;
  }
  color = vec4(c, 1.0);
}`;

export class Preview {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private photoTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private lutSize = 0;
  private space: RgbSpace = "srgb";
  split = 0.5;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    // Our values are Display P3 encoded; tell the compositor so P3 screens show them right.
    if ("drawingBufferColorSpace" in gl) gl.drawingBufferColorSpace = "display-p3";
    this.gl = gl;
    this.prog = program(gl, VERT, FRAG);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.photoTex = gl.createTexture()!;
    this.lutTex = gl.createTexture()!;
  }

  setPhoto(bitmap: ImageBitmap, space: RgbSpace) {
    const gl = this.gl;
    this.space = space;
    gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
    // Upload the code values as they are; the shader does the only conversion.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setLut(lut: Lut | null) {
    const gl = this.gl;
    this.lutSize = lut ? lut.size : 0;
    if (!lut) return;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // RGB16F is filterable in core WebGL2 (RGB32F needs an extension).
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
  }

  draw() {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    const u = (n: string) => gl.getUniformLocation(this.prog, n);
    gl.uniform1i(u("photo"), 0);
    gl.uniform1i(u("lut"), 1);
    gl.uniform1f(u("lutSize"), this.lutSize);
    gl.uniform1i(u("hasLut"), this.lutSize > 0 ? 1 : 0);
    gl.uniform1i(u("srgbInput"), this.space === "srgb" ? 1 : 0);
    // GLSL matrices are column-major.
    gl.uniformMatrix3fv(u("srgbToP3"), false, [0, 1, 2].flatMap((j) => SRGB_TO_P3.map((row) => row[j])));
    gl.uniform1f(u("split"), this.split);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
