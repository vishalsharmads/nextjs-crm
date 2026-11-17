/**
 * The 3D world of the story page: one bolt of cloth (nine panels) that is measured, cut, turned into a ring of
 * industries, stitched with modules, laid out as a pipeline board and finally labelled with the business's
 * name; plus the gold AI thread that runs through four gates. The scene only draws `StoryState`; the scroll
 * timeline in `story.ts` decides the values.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  ColorManagement,
  DoubleSide,
  Float32BufferAttribute,
  FogExp2,
  Group,
  LinearSRGBColorSpace,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
  type IUniform,
} from 'three';
import { coreModules, type StoryIndustry } from '../../data/story';

// Colors are the site's CSS tokens, used as-is (no color management), so WebGL matches the page exactly.
ColorManagement.enabled = false;

const C = {
  bg: 0x0b1a15,
  cloth: 0x0c1c16,
  clothHi: 0x3a6b55,
  gold: 0xd9b25a,
  ink: '#12201b',
  steel: '#5e6b66',
  chalk: '#f3f6f1',
  text: '#eef2ec',
  goldCss: '#d9b25a',
};
const DISPLAY = '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif';
const BODY = '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif';

import type { StoryScene, StoryState } from './state';

/* ------------------------------------------------------------------ shaders */

const WAVE = /* glsl */ `
  uniform float uTime;
  uniform float uWave;
  float H(vec2 p) {
    return (sin(p.x * 1.1 + uTime * 0.6) * 0.5
      + sin(p.y * 1.6 + p.x * 0.5 + uTime * 0.8) * 0.32
      + sin((p.x + p.y) * 2.4 - uTime * 0.7) * 0.12) * 0.42 * uWave;
  }
`;

const panelVertex = /* glsl */ `
  ${WAVE}
  uniform vec2 uOffset;
  uniform float uRoll;
  varying vec2 vUv;
  varying vec2 vCloth;
  varying float vShade;
  void main() {
    vUv = uv;
    vec2 c = uOffset + position.xy;
    vCloth = c;
    // The bolt unrolls toward the viewer: cloth below the roll front is still wound on the roll.
    float front = mix(2.3, -3.0, uRoll);
    float laid = smoothstep(0.0, 0.6, c.y - front);
    float z = H(c) * laid;
    float e = 0.04;
    vec3 n = normalize(vec3(-(H(c + vec2(e, 0.0)) - z) / e, -(H(c + vec2(0.0, e)) - z) / e, 1.0));
    vShade = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
    vec3 p = vec3(position.xy, z);
    float d = front - c.y;
    if (d > 0.0) {
      float r = 0.09 + d * 0.012;
      float a = d / r;
      p.y = front - r * sin(a) - uOffset.y;
      p.z = r - r * cos(a);
      vShade = 0.3 + 0.45 * (0.5 + 0.5 * cos(a - 0.9));
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const panelFragment = /* glsl */ `
  uniform vec3 uCloth;
  uniform vec3 uClothHi;
  uniform vec3 uGold;
  uniform float uPattern;
  uniform float uCut;
  uniform float uShear;
  uniform float uStitch;
  uniform float uLabelMix;
  uniform float uDim;
  uniform float uActive;
  uniform float uAlpha;
  uniform sampler2D uLabel;
  varying vec2 vUv;
  varying vec2 vCloth;
  varying float vShade;

  // Position around the panel's outline, 0..1, so lines can be drawn on progressively.
  float perim(vec2 uv) {
    float dB = uv.y, dR = 1.0 - uv.x, dT = 1.0 - uv.y, dL = uv.x;
    float m = min(min(dB, dR), min(dT, dL));
    if (m == dB) return uv.x * 0.25;
    if (m == dR) return 0.25 + uv.y * 0.25;
    if (m == dT) return 0.5 + (1.0 - uv.x) * 0.25;
    return 0.75 + (1.0 - uv.y) * 0.25;
  }

  void main() {
    // folds: dark in the valleys, a soft sheen on the crests
    vec3 col = mix(uCloth * 0.55, uClothHi, pow(vShade, 1.6));
    col += pow(vShade, 10.0) * vec3(0.16, 0.15, 0.1);
    // twill weave and the cutting-mat grid
    col *= 0.93 + 0.07 * sin((vCloth.x + vCloth.y) * 95.0);
    vec2 g = abs(fract(vCloth / 0.3 - 0.5) - 0.5) / fwidth(vCloth / 0.3);
    col += (1.0 - min(min(g.x, g.y), 1.0)) * 0.035;

    float ed = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float aa = fwidth(ed);
    float per = perim(vUv);

    // the paper pattern: a dashed gold outline, drawn on around the panel
    float line = 1.0 - smoothstep(0.003, 0.003 + aa * 1.5, abs(ed - 0.07));
    float dash = step(0.45, fract(per * 48.0));
    col = mix(col, uGold, line * dash * step(per, uPattern * 1.001));

    // a clean cut edge
    float edge = 1.0 - smoothstep(0.0, 0.01 + aa, ed);
    col = mix(col, uGold, edge * max(uCut, uActive));

    // the shears: a bright line runs along the inner seams just before the pieces part
    float sweep = (vCloth.x + vCloth.y + 4.6) / 9.2;
    float inner = step(max(abs(vCloth.x), abs(vCloth.y)), 2.2);
    float seam = (1.0 - smoothstep(0.0, 0.016 + aa, ed)) * inner * (1.0 - uCut);
    col = mix(col, uGold, seam * step(sweep, uShear));
    col += vec3(1.0, 0.85, 0.5) * seam * exp(-abs(sweep - uShear) * 26.0) * step(0.001, uShear) * step(uShear, 0.999);

    // running stitch along the seams
    float st = (1.0 - smoothstep(0.004, 0.004 + aa * 1.5, abs(ed - 0.028))) * step(0.5, fract(per * 72.0));
    col = mix(col, uGold, st * uStitch);

    // the selvedge: a lighter woven border on the outside of the bolt
    float outer = max(abs(vCloth.x), abs(vCloth.y));
    col = mix(col, uClothHi * 0.8, 0.6 * smoothstep(2.17, 2.215, outer) * (1.0 - uCut) * (1.0 - uActive));

    if (gl_FrontFacing) {
      vec4 lab = texture2D(uLabel, vUv);
      col = mix(col, lab.rgb, lab.a * uLabelMix);
    }
    col += vec3(0.05, 0.04, 0.0) * uActive;
    col *= 1.0 - 0.72 * uDim;
    gl_FragColor = vec4(col, uAlpha);
  }
`;

const ribbonVertex = /* glsl */ `
  ${WAVE}
  uniform float uFollow;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.z += H(p.xy) * uFollow + 0.04 * uFollow;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const ribbonFragment = /* glsl */ `
  uniform float uDraw;
  uniform float uAlpha;
  uniform float uLen;
  uniform float uTicks;
  uniform vec3 uGold;
  uniform vec3 uInk;
  varying vec2 vUv;
  void main() {
    if (vUv.x > uDraw || uAlpha <= 0.001) discard;
    vec3 col = uGold;
    float d = vUv.x * uLen;
    float minor = step(fract(d * 10.0), 0.09) * step(0.62, vUv.y);
    float major = step(fract(d), 0.012) * step(0.3, vUv.y);
    col = mix(col, uInk, max(minor, major) * uTicks);
    // a bright leading edge while it is drawing
    col += smoothstep(uDraw - 0.025, uDraw, vUv.x) * 0.35 * step(uDraw, 0.999);
    float soft = mix(1.0, smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.65, vUv.y), 1.0 - uTicks);
    gl_FragColor = vec4(col * (1.0 + 0.25 * (1.0 - uTicks)), uAlpha * soft);
  }
`;

const dustVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uPx;
  varying float vA;
  void main() {
    vec3 p = position;
    p.y += sin(uTime * 0.18 + aSeed * 6.28) * 0.35;
    p.x += cos(uTime * 0.13 + aSeed * 3.0) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPx * (1.0 + aSeed * 1.6) * (6.0 / -mv.z);
    vA = 0.2 + 0.35 * aSeed;
  }
`;

const dustFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(uColor, vA * (1.0 - d * 2.0));
  }
`;

/* ------------------------------------------------------------------ helpers */

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function canvas(w: number, h: number) {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  return { el, ctx };
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A flat ribbon along a curve; `side` is the axis the ribbon's width lies across. */
function ribbon(curve: CatmullRomCurve3, width: number, segments: number, up: Vector3) {
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const side = new Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    side
      .crossVectors(tan, up)
      .normalize()
      .multiplyScalar(width / 2);
    pos.push(p.x - side.x, p.y - side.y, p.z - side.z, p.x + side.x, p.y + side.y, p.z + side.z);
    uv.push(t, 0, t, 1);
    if (i < segments) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/* ------------------------------------------------------------------ the scene */

const S = 1.5; // panel size; the whole cloth is 3 × 3 panels
const COL_W = 0.72; // pipeline column scale
const COL_H = 1.6;
const GATE_AT = [0.25, 0.45, 0.65, 0.85];
const GATE_LABELS = [
  'Sees only what you see',
  'Asks before it changes',
  'Logs every action',
  'Your provider, your model',
];

export function createScene(
  el: HTMLCanvasElement,
  industries: StoryIndustry[],
  first: StoryIndustry,
  opts: { unroll: boolean },
): StoryScene {
  const renderer = new WebGLRenderer({
    canvas: el,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  scene.fog = new FogExp2(C.bg, 0.045);
  const camera = new PerspectiveCamera(40, 1, 0.1, 80);

  const time: IUniform<number> = { value: 0 };
  const wave: IUniform<number> = { value: 1 };
  const shared = {
    uTime: time,
    uWave: wave,
    uCloth: { value: new Color(C.cloth) },
    uClothHi: { value: new Color(C.clothHi) },
    uGold: { value: new Color(C.gold) },
    uPattern: { value: 0 },
    uCut: { value: 0 },
    uStitch: { value: 0 },
    uLabelMix: { value: 0 },
    uDim: { value: 0 },
    uShear: { value: 0 },
    uRoll: { value: 1 },
  };

  /* the cloth: nine panels */
  const cloth = new Group();
  scene.add(cloth);
  const panelGeo = new PlaneGeometry(S, S, 40, 40);
  const panels = Array.from({ length: 9 }, (_, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const grid = new Vector3((col - 1) * S, (1 - row) * S, 0);
    const { el: labelCanvas, ctx } = canvas(512, 512);
    const tex = new CanvasTexture(labelCanvas);
    tex.anisotropy = 4;
    const mat = new ShaderMaterial({
      vertexShader: panelVertex,
      fragmentShader: panelFragment,
      side: DoubleSide,
      transparent: true,
      uniforms: {
        ...shared,
        uOffset: { value: grid.clone() },
        uLabel: { value: tex },
        uActive: { value: 0 },
        uAlpha: { value: 1 },
      },
    });
    const mesh = new Mesh(panelGeo, mat);
    cloth.add(mesh);
    // a little seeded disorder for the cut
    const jz = Math.sin(i * 12.9898) * 0.5;
    const jr = Math.cos(i * 78.233) * 0.5;
    return { mesh, mat, grid, ctx, tex, jz, jr };
  });

  /* record cards for the pipeline board */
  const cardGeo = new PlaneGeometry(0.94, 0.47);
  const cards = Array.from({ length: 5 }, () => {
    const { el: c, ctx } = canvas(512, 256);
    const tex = new CanvasTexture(c);
    tex.anisotropy = 4;
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, fog: false });
    const mesh = new Mesh(cardGeo, mat);
    cloth.add(mesh);
    return { mesh, mat, ctx, tex, stage: 0, has: false };
  });

  /* the woven label */
  const badgeCanvas = canvas(1024, 512);
  const badgeTex = new CanvasTexture(badgeCanvas.el);
  badgeTex.anisotropy = 4;
  const badgeMat = new MeshBasicMaterial({ map: badgeTex, transparent: true, opacity: 0, fog: false });
  const badge = new Mesh(new PlaneGeometry(2.0, 1.0), badgeMat);
  cloth.add(badge);

  /* a soft contact shadow under the cloth, for weight */
  const shadowCanvas = canvas(256, 256);
  const grad = shadowCanvas.ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.75)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  shadowCanvas.ctx.fillStyle = grad;
  shadowCanvas.ctx.fillRect(0, 0, 256, 256);
  const shadowMat = new MeshBasicMaterial({
    map: new CanvasTexture(shadowCanvas.el),
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const shadow = new Mesh(new PlaneGeometry(7.4, 7.4), shadowMat);
  shadow.position.z = -0.75;
  cloth.add(shadow);

  /* loose thread fibres that fly off the seams when the shears go through */
  const FIBRES = 260;
  const fPos = new Float32Array(FIBRES * 3);
  const fDir = new Float32Array(FIBRES * 3);
  const fSeed = new Float32Array(FIBRES);
  for (let i = 0; i < FIBRES; i++) {
    const vertical = i % 2 === 0;
    const line = Math.random() < 0.5 ? -0.75 : 0.75;
    const along = (Math.random() - 0.5) * 4.4;
    const side = Math.random() < 0.5 ? -1 : 1;
    fPos.set(vertical ? [line, along, 0.02] : [along, line, 0.02], i * 3);
    const spread = 0.25 + Math.random() * 0.75;
    fDir.set(
      vertical
        ? [side * spread, (Math.random() - 0.5) * 0.4, 0.4 + Math.random()]
        : [(Math.random() - 0.5) * 0.4, side * spread, 0.4 + Math.random()],
      i * 3,
    );
    fSeed[i] = Math.random();
  }
  const fibreGeo = new BufferGeometry();
  fibreGeo.setAttribute('position', new Float32BufferAttribute(fPos, 3));
  fibreGeo.setAttribute('aDir', new Float32BufferAttribute(fDir, 3));
  fibreGeo.setAttribute('aSeed', new Float32BufferAttribute(fSeed, 1));
  const fibreMat = new ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aDir;
      attribute float aSeed;
      uniform float uT;
      uniform float uPx;
      varying float vA;
      void main() {
        float t = clamp(uT * (1.0 + aSeed * 0.6), 0.0, 1.0);
        vec3 p = position + aDir * t * 0.9;
        p.z -= t * t * 0.6; // they fall back down
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uPx * (1.0 + aSeed) * (7.0 / -mv.z);
        vA = sin(3.14159 * t) * (0.5 + 0.5 * aSeed);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5 || vA <= 0.0) discard;
        gl_FragColor = vec4(uColor, vA * (1.0 - d * 2.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uT: { value: 0 }, uPx: { value: 2 }, uColor: { value: new Color(0xf0cf80) } },
  });
  const fibres = new Points(fibreGeo, fibreMat);
  cloth.add(fibres);

  /* the measuring tape, lying on the cloth */
  const tapeCurve = new CatmullRomCurve3([
    new Vector3(-2.0, -1.85, 0),
    new Vector3(-1.5, -0.55, 0),
    new Vector3(0, -0.85, 0),
    new Vector3(1.5, 0.35, 0),
    new Vector3(3.5, 0.95, 0),
  ]);
  const tapeMat = new ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: ribbonFragment,
    transparent: true,
    side: DoubleSide,
    uniforms: {
      uTime: time,
      uWave: wave,
      uFollow: { value: 1 },
      uDraw: { value: 0 },
      uAlpha: { value: 1 },
      uLen: { value: tapeCurve.getLength() },
      uTicks: { value: 1 },
      uGold: { value: new Color(C.gold) },
      uInk: { value: new Color(0x1a1405) },
    },
  });
  const tape = new Mesh(ribbon(tapeCurve, 0.17, 260, new Vector3(0, 0, 1)), tapeMat);
  cloth.add(tape);

  /* the gold thread and its four gates */
  const threadCurve = new CatmullRomCurve3([
    new Vector3(0, 0.2, 3.0),
    new Vector3(1.0, 0.5, -1.5),
    new Vector3(-1.0, -0.3, -6.5),
    new Vector3(1.1, 0.45, -11.5),
    new Vector3(-0.9, -0.25, -16.5),
    new Vector3(0.8, 0.35, -21.5),
    new Vector3(0, 0, -27),
  ]);
  const threadMat = new ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: ribbonFragment,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: time,
      uWave: wave,
      uFollow: { value: 0 },
      uDraw: { value: 0 },
      uAlpha: { value: 0 },
      uLen: { value: threadCurve.getLength() },
      uTicks: { value: 0 },
      uGold: { value: new Color(C.gold) },
      uInk: { value: new Color(0x1a1405) },
    },
  });
  const thread = new Mesh(ribbon(threadCurve, 0.07, 600, new Vector3(0, 1, 0)), threadMat);
  scene.add(thread);

  const gateGeo = new TorusGeometry(1.15, 0.022, 12, 120);
  const gates = GATE_AT.map((u, i) => {
    const group = new Group();
    const p = threadCurve.getPointAt(u);
    group.position.copy(p);
    group.lookAt(threadCurve.getPointAt(Math.min(1, u + 0.01)));
    const mat = new MeshBasicMaterial({ color: C.gold, transparent: true, opacity: 0 });
    group.add(new Mesh(gateGeo, mat));
    const { el: lc, ctx } = canvas(1024, 160);
    ctx.font = `600 64px ${DISPLAY}`;
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GATE_LABELS[i], 512, 80);
    const labelMat = new MeshBasicMaterial({ map: new CanvasTexture(lc), transparent: true, opacity: 0 });
    const label = new Mesh(new PlaneGeometry(2.4, 0.375), labelMat);
    label.position.set(0, -1.5, 0);
    label.rotation.y = Math.PI; // the group faces forward along the path; the label faces the camera behind it
    group.add(label);
    scene.add(group);
    return {
      u,
      mat,
      labelMat,
      drawLabel: () => {
        ctx.clearRect(0, 0, 1024, 160);
        ctx.font = `600 64px ${DISPLAY}`;
        ctx.fillText(GATE_LABELS[i], 512, 80);
        (labelMat.map as CanvasTexture).needsUpdate = true;
      },
    };
  });

  /* dust in the air, for depth */
  const DUST = 700;
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 16;
    dustPos[i * 3 + 1] = (Math.random() - 0.5) * 10;
    dustPos[i * 3 + 2] = 6 - Math.random() * 36;
    dustSeed[i] = Math.random();
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute('position', new Float32BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSeed', new Float32BufferAttribute(dustSeed, 1));
  const dustMat = new ShaderMaterial({
    vertexShader: dustVertex,
    fragmentShader: dustFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: time, uPx: { value: 2 }, uColor: { value: new Color(0xe9d9a8) } },
  });
  scene.add(new Points(dustGeo, dustMat));

  /* ---------------------------------------------------------------- labels */

  let ind = first;
  // -1 for a business described under "Other": no panel of the ring is its own
  let selected = industries.findIndex((i) => i.slug === first.slug);
  let drawnSet = -1;

  function drawPanels(set: number) {
    const modules = [...ind.modules.map((m) => m.name), ...coreModules];
    panels.forEach((p, i) => {
      const { ctx } = p;
      ctx.clearRect(0, 0, 512, 512);
      ctx.save();
      ctx.textBaseline = 'alphabetic';
      if (set === 2) {
        // Columns are stretched tall; squash the drawing so text looks right once stretched.
        ctx.scale(1, COL_W / COL_H);
        if (i < Math.min(5, ind.stages.length)) {
          ctx.fillStyle = C.goldCss;
          ctx.font = `600 30px ${BODY}`;
          ctx.fillText(`STAGE ${i + 1}`, 44, 84);
          ctx.fillStyle = C.text;
          ctx.font = `600 54px ${DISPLAY}`;
          wrap(ctx, ind.stages[i], 430).forEach((l, n) => ctx.fillText(l, 44, 150 + n * 58));
        }
      } else {
        const eyebrow = set === 0 ? `TEMPLATE ${String(i + 1).padStart(2, '0')}` : 'MODULE';
        const name = set === 0 ? (industries[i]?.short ?? '') : (modules[i] ?? '');
        const sub =
          set === 0
            ? industries[i]
              ? `${industries[i].vocab.deals} · ${industries[i].vocab.contacts}`
              : ''
            : (ind.modules[i]?.use ?? 'In every workspace');
        // a soft dark plate so the words stay legible over the weave
        ctx.fillStyle = 'rgba(8, 21, 16, 0.55)';
        roundRect(ctx, 38, 38, 436, 436, 18);
        ctx.fill();
        ctx.fillStyle = C.goldCss;
        ctx.font = `600 30px ${BODY}`;
        ctx.fillText(eyebrow, 66, 104);
        ctx.fillStyle = C.text;
        ctx.font = `620 72px ${DISPLAY}`;
        wrap(ctx, name, 390)
          .slice(0, 3)
          .forEach((l, n) => ctx.fillText(l, 64, 190 + n * 74));
        ctx.globalAlpha = 0.78;
        ctx.font = `500 30px ${BODY}`;
        const subLines = wrap(ctx, sub, 390).slice(0, 3);
        subLines.forEach((l, n) => ctx.fillText(l, 66, 440 - (subLines.length - 1 - n) * 38));
      }
      ctx.restore();
      p.tex.needsUpdate = true;
    });
    drawnSet = set;
  }

  function drawCards() {
    cards.forEach((c, i) => {
      const data = ind.cards[i];
      c.has = !!data && data.stage < Math.min(5, ind.stages.length);
      c.stage = data?.stage ?? i;
      const { ctx } = c;
      ctx.clearRect(0, 0, 512, 256);
      if (!data) return;
      ctx.fillStyle = C.chalk;
      roundRect(ctx, 4, 4, 504, 248, 26);
      ctx.fill();
      // the workspace's own brand color, as on its cards in the product
      ctx.fillStyle = ind.accent;
      roundRect(ctx, 4, 4, 12, 248, 6);
      ctx.fill();
      ctx.fillStyle = C.ink;
      ctx.font = `600 44px ${DISPLAY}`;
      ctx.fillText(wrap(ctx, data.name, 440)[0], 40, 100);
      ctx.fillStyle = C.steel;
      ctx.font = `500 32px ${BODY}`;
      ctx.fillText(wrap(ctx, data.detail, 440)[0], 40, 170);
      c.tex.needsUpdate = true;
    });
  }

  function drawBadge() {
    const { ctx } = badgeCanvas;
    ctx.clearRect(0, 0, 1024, 512);
    ctx.fillStyle = C.goldCss;
    roundRect(ctx, 8, 8, 1008, 496, 28);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 14]);
    roundRect(ctx, 34, 34, 956, 444, 18);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'center';
    ctx.font = `600 34px ${BODY}`;
    ctx.fillText('MADE TO MEASURE FOR', 512, 170);
    let size = 112;
    do {
      ctx.font = `650 ${size}px ${DISPLAY}`;
      size -= 4;
    } while (ctx.measureText(ind.business).width > 860 && size > 40);
    ctx.fillText(ind.business, 512, 300);
    ctx.font = `500 32px ${BODY}`;
    ctx.fillText('Your name on the label · Your data in your vault', 512, 400);
    badgeTex.needsUpdate = true;
  }

  function redrawAll() {
    drawPanels(drawnSet < 0 ? 0 : drawnSet);
    drawCards();
    drawBadge();
    gates.forEach((g) => g.drawLabel());
  }
  redrawAll();
  // Canvas text needs the web fonts; redraw once they are in.
  void document.fonts?.ready.then(redrawAll);

  /* ---------------------------------------------------------------- layout */

  let narrow = false;
  // Lowered (never below 1) if frames run slow, so older laptops and phones stay smooth.
  let maxDpr = 1.75;
  let portraitScale = 1;
  function resize() {
    const w = el.clientWidth;
    const h = el.clientHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    narrow = w < 900;
    portraitScale = camera.aspect < 1.2 ? Math.min(1.9, 1.25 / camera.aspect) : 1;
    // Shift the picture away from the text: right on wide screens, up on narrow ones.
    if (narrow) camera.setViewOffset(w, h, 0, h * 0.24, w, h);
    else camera.setViewOffset(w, h, -w * 0.19, 0, w, h);
    camera.updateProjectionMatrix();
    dustMat.uniforms.uPx.value = 2 * renderer.getPixelRatio();
    fibreMat.uniforms.uPx.value = 2.2 * renderer.getPixelRatio();
  }
  resize();

  /* ---------------------------------------------------------------- frame */

  const v = new Vector3();
  const look = new Vector3();
  const tmp = new Vector3();
  let spinNow = -Math.max(0, selected) * (TAU / 9);
  // The bolt unrolls once, on the first screen; arriving mid-story it is already flat.
  let roll = opts.unroll ? 0 : 1;
  let intro = opts.unroll ? 0 : 1;
  // A slight sway with the pointer, on devices that have one.
  const fine = window.matchMedia('(pointer: fine)').matches;
  let px = 0;
  let py = 0;
  let pxNow = 0;
  let pyNow = 0;
  const onPointer = (e: PointerEvent) => {
    px = (e.clientX / window.innerWidth) * 2 - 1;
    py = (e.clientY / window.innerHeight) * 2 - 1;
  };
  if (fine) window.addEventListener('pointermove', onPointer, { passive: true });
  let slowFrames = 0;
  let frames = 0;

  function frame(st: StoryState, dt: number) {
    time.value += dt;
    roll = Math.min(1, roll + dt / 2.2);
    shared.uRoll.value = 1 - Math.pow(1 - roll, 3);
    if (roll >= 1) intro = Math.min(1, intro + dt / 1.6);
    shared.uShear.value = st.shear;
    fibreMat.uniforms.uT.value = st.cut;
    fibres.visible = st.cut > 0.001 && st.cut < 0.999;

    // adaptive resolution: if most of the last 90 frames took longer than 1/40 s, render fewer pixels
    frames++;
    if (dt > 1 / 40) slowFrames++;
    if (frames >= 90) {
      if (slowFrames > 60 && maxDpr > 1) {
        maxDpr = Math.max(1, maxDpr - 0.35);
        resize();
      }
      frames = 0;
      slowFrames = 0;
    }
    wave.value = st.wave;
    shared.uPattern.value = st.pattern;
    shared.uCut.value = st.cut;
    shared.uStitch.value = st.stitch;
    shared.uLabelMix.value = st.labelMix;
    shared.uDim.value = st.dim;
    if (st.labelSet !== drawnSet) drawPanels(st.labelSet);

    /* cloth group */
    cloth.rotation.x = st.tilt;
    cloth.rotation.y = st.turn;
    cloth.position.y = -st.dim * 3.2;
    cloth.scale.setScalar(1 - st.dim * 0.25);

    /* panels */
    const spinTarget = selected < 0 ? spinNow : -selected * (TAU / 9);
    // turn the shortest way round to the chosen industry
    let delta = spinTarget - spinNow;
    delta = ((((delta + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    spinNow += delta * (1 - Math.exp(-dt * 4));
    const R = 3.9;
    const ring = ease(clamp01(st.ring));
    const board = ease(clamp01(st.board));
    // the board steps back when the real product screen takes its place
    const handover = 1 - ease(clamp01(st.proof));
    const nCols = Math.min(5, ind.stages.length);
    const colX = (k: number) => (k - (nCols - 1) / 2) * 1.2;
    panels.forEach((p, i) => {
      const sep = st.cut;
      // 1. assembled or cut
      v.set(p.grid.x * (1 + 0.24 * sep), p.grid.y * (1 + 0.24 * sep), p.jz * sep * 0.7);
      let ry = 0;
      let rz = p.jr * sep * 0.22;
      // 2. ring of industries
      const a = (i / 9) * TAU + spinNow + st.spin * 0.25;
      tmp.set(Math.sin(a) * R, 0, Math.cos(a) * R - R);
      v.lerp(tmp, ring);
      ry = MathUtils.lerp(ry, a, ring);
      rz = MathUtils.lerp(rz, 0, ring);
      // 3. pipeline columns
      let sx = 1;
      let sy = 1;
      let alpha = 1;
      if (i < nCols) tmp.set(colX(i), 0, 0);
      else tmp.set(p.grid.x * 0.4, -2.6, -0.5);
      v.lerp(tmp, board);
      ry = MathUtils.lerp(ry, 0, board);
      rz = MathUtils.lerp(rz, 0, board);
      if (i < nCols) {
        sx = MathUtils.lerp(1, COL_W, board);
        sy = MathUtils.lerp(1, COL_H, board);
      } else {
        sx = sy = 1 - board;
        alpha = 1 - board;
      }
      p.mesh.position.copy(v);
      p.mesh.rotation.set(0, ry, rz);
      p.mesh.scale.set(Math.max(sx, 0.001), Math.max(sy, 0.001), 1);
      alpha *= handover;
      p.mesh.visible = alpha > 0.01;
      p.mat.uniforms.uAlpha.value = alpha;
      const isSel = i === selected ? 1 : 0;
      p.mat.uniforms.uActive.value = isSel * ring * (st.labelSet === 0 ? 1 : 0);
    });

    /* cards on the board: the latest stage moves first, so columns never pile up */
    const order = [...cards].sort((a, b) => b.stage - a.stage);
    const last = nCols - 1;
    const movers = order.filter((c) => c.has && c.stage < last);
    cards.forEach((c) => {
      const show = c.has ? clamp01(st.cards) * board * (1 - st.dim) * handover : 0;
      c.mat.opacity = show;
      c.mesh.visible = show > 0.01;
      const k = movers.indexOf(c);
      const f = k < 0 ? 0 : smooth(k * 0.22, k * 0.22 + 0.34, st.cardMove);
      const from = c.stage;
      const to = Math.min(last, c.stage + 1);
      const x = MathUtils.lerp(colX(from), colX(to), f);
      const slotTo = to === last && k >= 0 ? 1 : 0;
      const y = MathUtils.lerp(0.42, 0.42 - slotTo * 0.56, f);
      c.mesh.position.set(x, y - (1 - show) * 0.3, 0.06 + Math.sin(Math.PI * f) * 0.4);
      c.mesh.rotation.z = Math.sin(Math.PI * f) * -0.08;
    });

    /* the woven label */
    const b = ease(clamp01(st.badge));
    badgeMat.opacity = b;
    badge.visible = b > 0.01;
    badge.scale.setScalar(0.7 + 0.3 * b);
    badge.position.set(0, -0.1, 0.32 + (1 - b) * 0.8);
    badge.rotation.z = (1 - b) * 0.2;

    /* contact shadow: only while the cloth lies as one piece */
    const laid = shared.uRoll.value;
    shadowMat.opacity = 0.85 * laid * (1 - ring) * (1 - board) * (1 - st.dim) * (1 - st.cut * 0.6);
    shadow.scale.set(1, Math.max(0.05, laid), 1);
    shadow.position.y = (1 - laid) * 2.2;
    shadow.visible = shadowMat.opacity > 0.01;

    /* tape */
    tapeMat.uniforms.uDraw.value = st.tapeDraw * ease(intro);
    tapeMat.uniforms.uAlpha.value = st.tapeAlpha * (1 - st.cut);
    tape.visible = st.tapeAlpha > 0.01;

    /* thread and gates */
    const fly = ease(clamp01(st.fly));
    threadMat.uniforms.uDraw.value = Math.min(1, st.flyT + 0.06);
    threadMat.uniforms.uAlpha.value = clamp01(st.gates) * 0.95;
    thread.visible = st.gates > 0.01;
    gates.forEach((g) => {
      // lit as the camera nears it; its caption shows on the approach and is gone before the camera passes
      const lit = smooth(g.u - 0.12, g.u - 0.04, st.flyT);
      const caption = smooth(g.u - 0.17, g.u - 0.11, st.flyT) * (1 - smooth(g.u - 0.03, g.u + 0.01, st.flyT));
      g.mat.opacity = st.gates * (0.25 + 0.75 * lit);
      g.labelMat.opacity = st.gates * caption;
    });

    /* camera */
    v.set(st.camX, st.camY, st.camZ);
    look.set(st.lookX, st.lookY, st.lookZ);
    v.sub(look).multiplyScalar(portraitScale).add(look);
    if (fly > 0.001) {
      const u = clamp01(st.flyT) * 0.97;
      const back = Math.max(0, u - 0.05);
      const pos = threadCurve.getPointAt(back);
      const tan = threadCurve.getTangentAt(back);
      tmp.copy(pos).addScaledVector(tan, -1.6);
      tmp.y += 0.55;
      v.lerp(tmp, fly);
      look.lerp(threadCurve.getPointAt(Math.min(1, u + 0.04)), fly);
    }
    if (fine) {
      pxNow += (px - pxNow) * (1 - Math.exp(-dt * 3));
      pyNow += (py - pyNow) * (1 - Math.exp(-dt * 3));
      const sway = 1 - fly;
      v.x += pxNow * 0.35 * sway;
      v.y -= pyNow * 0.22 * sway;
    }
    camera.position.copy(v);
    camera.lookAt(look);

    renderer.render(scene, camera);
  }

  return {
    setIndustry(next) {
      ind = next;
      selected = industries.findIndex((i) => i.slug === next.slug);
      redrawAll();
    },
    frame,
    resize,
    dispose() {
      window.removeEventListener('pointermove', onPointer);
      renderer.dispose();
    },
  };
}
