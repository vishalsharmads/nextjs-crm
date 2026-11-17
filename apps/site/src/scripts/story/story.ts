/**
 * The "Cut to measure" story page. Scroll position is turned into an act position (act index + progress through
 * that act's section), which drives one paused GSAP timeline of `StoryState` numbers (the 3D scene) and reveals
 * the text of each act (`data-at` / `data-until`, as fractions of the act's section).
 *
 * Without WebGL the text still plays over the static cutting-mat backdrop. With reduced motion nothing animates:
 * the page is plain, stacked sections (see the `html.motion` rules in story.astro).
 */
import { gsap } from 'gsap';
import {
  CUSTOM_DEFAULTS,
  STORY_OTHER,
  customIndustry,
  storyCopy,
  workspaceHtml,
  type CustomInput,
  type StoryIndustry,
} from '../../data/story';
import { initialState, type StoryScene, type StoryState } from './state';

const root = document.querySelector<HTMLElement>('[data-story]');
if (root) init(root);

function init(root: HTMLElement) {
  const industries = JSON.parse(root.dataset.industries ?? '[]') as StoryIndustry[];
  if (!industries.length) return;
  // ?for=<industry> opens the story already tailored (links from industry pages, ads, emails)
  const asked = new URLSearchParams(window.location.search).get('for');
  let current =
    industries.find((i) => i.slug === asked) ??
    industries.find((i) => i.slug === root.dataset.default) ??
    industries[0];
  const motion = document.documentElement.classList.contains('motion');

  /* ---------------------------------------------------------------- industry */

  const selects = [...root.querySelectorAll<HTMLSelectElement>('[data-industry-select]')];
  const choices = [...root.querySelectorAll<HTMLButtonElement>('[data-industry]')];
  let scene: StoryScene | null = null;

  function fillList(name: string, items: string[][]) {
    root.querySelectorAll<HTMLElement>(`[data-list="${name}"] > li`).forEach((li, n) => {
      const item = items[n];
      li.hidden = !item;
      if (!item) return;
      li.querySelectorAll<HTMLElement>('[data-part]').forEach(
        (part, k) => (part.textContent = item[k] ?? ''),
      );
    });
  }

  function applyIndustry(next: StoryIndustry) {
    current = next;
    const copy = storyCopy(next);
    root.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
      const key = el.dataset.t!;
      if (!(key in copy)) return;
      // Scrambling words keep their "before" text until their moment comes.
      if (el.dataset.scramble !== undefined) {
        el.dataset.final = copy[key];
        if (!motion || el.classList.contains('on')) el.textContent = copy[key];
        return;
      }
      el.textContent = copy[key];
    });
    fillList(
      'modules',
      next.modules.map((m) => [m.name, m.use]),
    );
    fillList(
      'day',
      next.day.map((d) => [d.time, d.what]),
    );
    fillList(
      'stages',
      next.stages.map((s) => [s]),
    );
    const workspace = root.querySelector<HTMLElement>('[data-workspace]');
    if (workspace) workspace.innerHTML = workspaceHtml(next);
    // While a described business is showing, "Other" carries its name
    root.querySelectorAll<HTMLOptionElement>(`option[value="${STORY_OTHER}"]`).forEach((o) => {
      o.textContent = next.slug === STORY_OTHER ? `Yours: ${next.business}` : 'Other: describe your business';
    });
    selects.forEach((s) => (s.value = next.slug));
    choices.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.industry === next.slug)));
    scene?.setIndustry(next);
  }

  function setUrl(slug: string | null) {
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set('for', slug);
    else url.searchParams.delete('for');
    window.history.replaceState(window.history.state, '', url);
  }

  function pick(slug: string) {
    if (slug === STORY_OTHER) return openOther();
    const next = industries.find((i) => i.slug === slug);
    if (!next || next.slug === current.slug) return;
    applyIndustry(next);
    setUrl(next.slug);
  }

  /* "Other": the visitor describes their business and the whole story plays in their words */
  const dialog = root.querySelector<HTMLDialogElement>('[data-other]');
  const form = root.querySelector<HTMLFormElement>('[data-other-form]');
  let custom: CustomInput = CUSTOM_DEFAULTS;
  function openOther() {
    if (!dialog || !form) return;
    const f = form.elements;
    const set = (name: string, value: string) => {
      const el = f.namedItem(name);
      if (el instanceof HTMLInputElement) el.value = value;
    };
    const mine = current.slug === STORY_OTHER;
    set('business', mine ? custom.business : '');
    set('contacts', mine ? custom.contacts : '');
    set('deals', mine ? custom.deals : '');
    set('stages', mine ? custom.stages.join(', ') : '');
    set('accent', custom.accent);
    dialog.showModal();
  }
  dialog?.addEventListener('close', () => {
    if (dialog.returnValue === 'ok' && form) {
      const data = new FormData(form);
      const text = (name: string, fallback: string) => String(data.get(name) ?? '').trim() || fallback;
      custom = {
        business: text('business', CUSTOM_DEFAULTS.business),
        contacts: text('contacts', CUSTOM_DEFAULTS.contacts),
        deals: text('deals', CUSTOM_DEFAULTS.deals),
        stages: text('stages', CUSTOM_DEFAULTS.stages.join(', ')).split(','),
        accent: text('accent', CUSTOM_DEFAULTS.accent),
      };
      applyIndustry(customIndustry(custom));
      setUrl(null);
    } else {
      // cancelled: the pickers go back to what is showing
      selects.forEach((s) => (s.value = current.slug));
    }
    dialog.returnValue = '';
  });

  selects.forEach((s) => s.addEventListener('change', () => pick(s.value)));
  choices.forEach((b) => b.addEventListener('click', () => pick(b.dataset.industry!)));

  applyIndustry(current);
  if (asked === STORY_OTHER) openOther();
  if (!motion) return;
  restoreScroll();

  /* ---------------------------------------------------------------- scene */

  // Three.js is loaded on its own, so the words and the picker work while it downloads.
  const canvas = root.querySelector<HTMLCanvasElement>('[data-stage]');
  if (canvas) {
    import('./scene')
      .then(({ createScene }) => {
        scene = createScene(canvas, industries, current, {
          unroll: window.scrollY < window.innerHeight * 0.5,
        });
        root.classList.remove('no-gl');
      })
      .catch(() => root.classList.add('no-gl'));
  } else root.classList.add('no-gl');

  const state: StoryState = initialState();
  const tl = buildTimeline(state);

  /* ---------------------------------------------------------------- scroll → act position */

  const acts = [...root.querySelectorAll<HTMLElement>('[data-act]')];
  let tops: number[] = [];
  let heights: number[] = [];
  function measure() {
    tops = acts.map((a) => a.getBoundingClientRect().top + window.scrollY);
    heights = acts.map((a) => a.offsetHeight);
  }
  function actPos() {
    const y = window.scrollY;
    for (let i = 0; i < acts.length; i++) {
      if (y < tops[i] + heights[i]) return i + Math.min(1, Math.max(0, (y - tops[i]) / heights[i]));
    }
    return acts.length;
  }

  /* ---------------------------------------------------------------- text reveals */

  const reveals = acts.map((act) =>
    [...act.querySelectorAll<HTMLElement>('[data-at]')].map((el) => ({
      el,
      at: Number(el.dataset.at),
      until: el.dataset.until ? Number(el.dataset.until) : Infinity,
      on: false,
    })),
  );
  const progressBar = root.querySelector<HTMLElement>('[data-progress]');
  const chapters = [...root.querySelectorAll<HTMLAnchorElement>('[data-chapter]')];
  const rail = root.querySelector<HTMLElement>('[data-chapters]');
  const picker = root.querySelector<HTMLElement>('[data-picker]');
  let lastActive = -1;

  function scramble(el: HTMLElement, to: string) {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const from = el.textContent ?? '';
    const len = Math.max(from.length, to.length);
    let frame = 0;
    const total = 22;
    const id = (el.dataset.scrambleId = String(Math.random()));
    const step = () => {
      if (el.dataset.scrambleId !== id) return;
      frame++;
      const done = Math.floor((frame / total) * len);
      let out = '';
      for (let i = 0; i < len; i++) {
        if (i < done) out += to[i] ?? '';
        else out += to[i] === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)];
      }
      el.textContent = frame >= total ? to : out;
      if (frame < total) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function updateReveals(pos: number) {
    reveals.forEach((list, i) => {
      const local = pos - i;
      for (const r of list) {
        const on = local >= r.at && local < r.until;
        if (on === r.on) continue;
        r.on = on;
        r.el.classList.toggle('on', on);
        if (r.el.dataset.scramble !== undefined) {
          const to = on ? (r.el.dataset.final ?? '') : (r.el.dataset.scramble ?? '');
          scramble(r.el, to);
        }
      }
    });
    const active = Math.min(acts.length - 1, Math.floor(pos));
    if (active !== lastActive) {
      lastActive = active;
      acts.forEach((a, i) => a.classList.toggle('is-active', i === active));
      chapters.forEach((c, i) => {
        if (i === active) c.setAttribute('aria-current', 'step');
        else c.removeAttribute('aria-current');
      });
    }
    // The industry picker shows from the measuring act until the finale.
    picker?.classList.toggle('on', pos >= 0.85 && pos < acts.length - 0.92);
    rail?.classList.toggle('on', pos >= 0.35 && pos < acts.length - 0.5);
    if (progressBar) progressBar.style.transform = `scaleY(${Math.min(1, pos / acts.length)})`;
  }

  /* ---------------------------------------------------------------- loop */

  measure();
  let target = actPos();
  let cur = target;
  tl.seek(cur);
  updateReveals(target);

  let visible = true;
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    root.classList.toggle('stage-off', !visible);
  }).observe(root);

  window.addEventListener('scroll', () => (target = actPos()), { passive: true });
  const onResize = () => {
    measure();
    target = actPos();
    scene?.resize();
  };
  window.addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe(root);

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Follow the scroll with a little lag, like scrub: 1, so wheel steps glide.
    cur += (target - cur) * (1 - Math.exp(-dt * 5.5));
    if (Math.abs(target - cur) < 0.0005) cur = target;
    tl.seek(cur);
    updateReveals(target);
    if (visible && scene) scene.frame(state, dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  root.dataset.ready = '';

  // "See how it's made" and other in-page links: jump to the act, then let the scroll play it.
  root.querySelectorAll<HTMLAnchorElement>('a[href^="#act-"]').forEach((a) =>
    a.addEventListener('click', (e) => {
      const el = document.querySelector(a.getAttribute('href')!);
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth' });
    }),
  );
}

/**
 * One unit of timeline = one act (one section of the page). The positions below are act.fraction:
 * 0 hero, 1 measure, 2 pattern and cut, 3 same cloth, 4 stitching, 5 fitting, 6 gold thread, 7 label, 8 finale.
 */
function buildTimeline(s: StoryState) {
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.inOut' } });
  const to = (vars: Partial<StoryState>, at: number, duration: number, ease?: string) =>
    tl.to(s, { ...vars, duration, ...(ease ? { ease } : {}) }, at);
  const set = (vars: Partial<StoryState>, at: number) => tl.set(s, vars, at);

  // 0 → 1: from the hero, lean over the cloth while the tape runs its length
  to({ camX: 1.4, camY: 4.8, camZ: 7.8, tilt: -1.0, wave: 0.55 }, 0, 1);
  to({ tapeDraw: 1 }, 0.1, 0.7, 'power1.inOut');

  // 1: the AI interview; drift slowly round the cloth
  to({ camX: -1.2, camY: 5.0, camZ: 7.4, turn: 0.12, wave: 0.45 }, 1, 1, 'none');

  // 2: the pattern is drawn, then cut
  to({ tapeAlpha: 0 }, 2, 0.1);
  set({ tapeDraw: 0 }, 2.12);
  to({ camX: 0, camY: 6.6, camZ: 6.9, turn: 0, wave: 0.22 }, 2, 0.55);
  to({ pattern: 1 }, 2.05, 0.4, 'power1.inOut');
  to({ shear: 1 }, 2.4, 0.12, 'power1.in');
  to({ cut: 1 }, 2.53, 0.3, 'power3.out');

  // 3: the same cloth, a ring of nine industries
  set({ labelSet: 0 }, 3);
  to({ ring: 1, tilt: 0, camX: 0, camY: 3.6, camZ: 8.4, lookY: -0.5, lookZ: -4.2 }, 3, 0.5);
  to({ labelMix: 1 }, 3.3, 0.16);
  to({ spin: 1 }, 3, 1, 'none');

  // 4: back together, stitched, every panel a module
  to({ labelMix: 0 }, 4, 0.1);
  set({ labelSet: 1 }, 4.12);
  to({ ring: 0, camX: 0.4, camY: 2.2, camZ: 9.4, lookY: 0, lookZ: 0, tilt: -0.4 }, 4, 0.45);
  to({ cut: 0, pattern: 0 }, 4.2, 0.3);
  to({ labelMix: 1 }, 4.42, 0.15);
  to({ stitch: 1 }, 4.45, 0.3, 'power1.inOut');

  // 5: the fitting, a working pipeline board
  to({ labelMix: 0, stitch: 0 }, 5, 0.1);
  set({ labelSet: 2 }, 5.11);
  to({ board: 1, tilt: 0, wave: 0, camX: 0, camY: 0.3, camZ: 9.6 }, 5, 0.35);
  to({ labelMix: 1 }, 5.28, 0.12);
  to({ cards: 1 }, 5.32, 0.1);
  to({ cardMove: 1 }, 5.36, 0.18, 'none');
  // and then the real thing: the board hands over to a screen from the product
  to({ proof: 1 }, 5.56, 0.08);

  // 6: the gold thread, flown through its four gates
  to({ labelMix: 0, cards: 0, proof: 0 }, 6, 0.06);
  to({ fly: 1, gates: 1, dim: 1 }, 6, 0.1);
  // gate captions show at flyT = u - 0.14, i.e. act 6 at .35, .43, .51, .60 (the text list follows them)
  to({ flyT: 1 }, 6.3, 0.42, 'none');

  // 7: back to the cloth, which gets its label
  to({ fly: 0, gates: 0 }, 7, 0.28);
  to({ dim: 0, board: 0, cardMove: 0, tilt: -0.62, wave: 0.32, camX: 0, camY: 2.4, camZ: 8.8 }, 7.02, 0.3);
  to({ stitch: 1 }, 7.15, 0.25);
  to({ badge: 1 }, 7.3, 0.2, 'back.out(1.4)');

  // 8: rise above the finished cloth; the tape comes back for the alterations
  to({ camX: 0, camY: 7.2, camZ: 3.2, tilt: -1.15, wave: 0.55 }, 8, 0.55);
  to({ tapeAlpha: 1 }, 8.05, 0.1);
  to({ tapeDraw: 1 }, 8.1, 0.4, 'power1.inOut');
  // pad to exactly nine units so tl.seek(actPos) lines up
  tl.set({}, {}, 9);
  return tl;
}

/**
 * The browser's own scroll restoration animates (the site uses smooth scrolling), which would fast-forward the
 * whole story on a reload. Restore instantly instead, and only on reload or back/forward.
 */
function restoreScroll() {
  const key = 'story-scroll';
  window.history.scrollRestoration = 'manual';
  window.addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(key, String(window.scrollY));
    } catch {
      // storage can be blocked; then a reload simply starts at the top
    }
  });
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (window.location.hash || (nav?.type !== 'reload' && nav?.type !== 'back_forward')) return;
  try {
    const y = Number(sessionStorage.getItem(key));
    if (y > 0) window.scrollTo({ top: y, behavior: 'instant' });
  } catch {
    // ignore
  }
}
