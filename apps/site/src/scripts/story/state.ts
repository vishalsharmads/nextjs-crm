/** The numbers the scroll timeline animates and the 3D scene draws. Kept apart so the page script
 * can build its timeline before Three.js has loaded. */
import type { StoryIndustry } from '../../data/story';

/** Everything the scroll timeline animates. Numbers only, so GSAP can tween them. */
export interface StoryState {
  camX: number;
  camY: number;
  camZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  /** Cloth tilt (rotation x) and turn (rotation y). */
  tilt: number;
  turn: number;
  wave: number;
  tapeDraw: number;
  tapeAlpha: number;
  /** Gold paper-pattern lines drawn on the cloth. */
  pattern: number;
  /** The shears' bright line running along the seams, just before the cut. */
  shear: number;
  /** Panels separated along the pattern. */
  cut: number;
  /** Panels arranged as a ring, one per industry. */
  ring: number;
  spin: number;
  stitch: number;
  /** Panels arranged as pipeline columns, with record cards. */
  board: number;
  cards: number;
  cardMove: number;
  labelMix: number;
  /** 0 industries, 1 modules, 2 stages. Changed with timeline sets, never tweened. */
  labelSet: number;
  /** Camera flies along the gold thread. */
  fly: number;
  flyT: number;
  gates: number;
  dim: number;
  /** The real product screenshot the board hands over to. */
  proof: number;
  /** The woven label with the business's name. */
  badge: number;
}

export function initialState(): StoryState {
  return {
    camX: 0,
    camY: 1.4,
    camZ: 10.5,
    lookX: 0,
    lookY: 0,
    lookZ: 0,
    tilt: -0.82,
    turn: 0,
    wave: 1,
    tapeDraw: 0.45,
    tapeAlpha: 1,
    pattern: 0,
    shear: 0,
    cut: 0,
    ring: 0,
    spin: 0,
    stitch: 0,
    board: 0,
    cards: 0,
    cardMove: 0,
    labelMix: 0,
    labelSet: 0,
    fly: 0,
    flyT: 0,
    gates: 0,
    dim: 0,
    proof: 0,
    badge: 0,
  };
}

export interface StoryScene {
  setIndustry(ind: StoryIndustry): void;
  frame(st: StoryState, dt: number): void;
  resize(): void;
  dispose(): void;
}
