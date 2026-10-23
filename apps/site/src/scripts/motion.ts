import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const root = document.documentElement;
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------
 * 1. The one orchestrated moment: the hero's page-load sequence.
 *    Purpose: first-visit delight + it draws the eye to the tape.
 *    Runs once per page view; skipped entirely with reduced motion.
 * ------------------------------------------------------------------ */
function heroIntro() {
  const hero = document.querySelector<HTMLElement>('[data-hero]');
  if (!hero || reduce || !root.classList.contains('motion')) {
    root.classList.add('motion-ready');
    return;
  }
  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
    onComplete: () => root.classList.add('motion-ready'),
  });
  tl.fromTo(
    hero.querySelectorAll('[data-hero-title] .line > span'),
    { yPercent: 105, y: 0, opacity: 1 },
    { yPercent: 0, duration: 0.9, stagger: 0.08 },
  )
    .fromTo(
      hero.querySelectorAll('[data-hero-fade]'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.08 },
      '-=0.55',
    )
    .fromTo(
      hero.querySelector('[data-hero-product]'),
      { clipPath: 'inset(0% 0% 100% 0%)' },
      { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.9, ease: 'expo.inOut' },
      0.15,
    )
    .fromTo(
      hero.querySelectorAll('.card'),
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.45, stagger: 0.05 },
      0.7,
    )
    .fromTo(
      hero.querySelector('[data-tape]'),
      { clipPath: 'inset(0% 100% 0% 0%)' },
      { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.1, ease: 'expo.inOut' },
      0.35,
    );
}

/* ------------------------------------------------------------------
 * 2. Re-tailoring: the tape swaps the mockup into another industry.
 *    Purpose: explanation (what "configured per industry" means).
 *    Triggered by the user; interruptible; blur bridges the swap.
 * ------------------------------------------------------------------ */
interface TailorData {
  slug: string;
  name: string;
  vocab: { contact: string; contacts: string; deal: string; deals: string };
  stages: string[];
  cards: { name: string; detail: string; stage: number }[];
}

function tailor() {
  const tape = document.querySelector<HTMLElement>('[data-tape]');
  const json = document.getElementById('tailor-data');
  const mock = document.getElementById('hero-mockup');
  if (!tape || !json || !mock) return;
  const all = JSON.parse(json.textContent ?? '[]') as TailorData[];
  const caption = document.querySelector<HTMLElement>('[data-k="caption"]');
  const marks = [...tape.querySelectorAll<HTMLButtonElement>('.mark')];

  const textFor = (i: TailorData): Record<string, string> => {
    const out: Record<string, string> = {
      contacts: i.vocab.contacts,
      deals: i.vocab.deals,
      'deal-lower': i.vocab.deal.toLowerCase(),
      caption: `Set up for ${i.name.toLowerCase()}: ${i.vocab.contacts.toLowerCase()}, ${i.vocab.deals.toLowerCase()} and five stages from ${i.stages[0]!.toLowerCase()} to ${i.stages.at(-1)!.toLowerCase()}.`,
    };
    i.stages.forEach((s, n) => (out[`stage-${n}`] = s));
    i.cards.forEach((c) => {
      out[`card-${c.stage}-name`] = c.name;
      out[`card-${c.stage}-detail`] = c.detail;
    });
    return out;
  };

  const nodes = [...mock.querySelectorAll<HTMLElement>('[data-k]'), ...(caption ? [caption] : [])];

  const apply = (i: TailorData) => {
    const text = textFor(i);
    for (const n of nodes) {
      const v = text[n.dataset.k!];
      if (v !== undefined) n.textContent = v;
    }
    mock.setAttribute(
      'aria-label',
      `The ${i.vocab.deals.toLowerCase()} board in Bespoq, set up for ${i.name.toLowerCase()}`,
    );
  };

  const select = (slug: string) => {
    const industry = all.find((i) => i.slug === slug);
    if (!industry) return;
    marks.forEach((m) => m.setAttribute('aria-pressed', String(m.dataset.slug === slug)));
    if (reduce) return apply(industry);
    gsap.killTweensOf(nodes);
    gsap
      .timeline()
      .to(nodes, { opacity: 0, filter: 'blur(4px)', duration: 0.14, ease: 'power2.out', stagger: 0.008 })
      .add(() => apply(industry))
      .to(nodes, { opacity: 1, filter: 'blur(0px)', duration: 0.24, ease: 'power3.out', stagger: 0.012 });
  };

  marks.forEach((m) => m.addEventListener('click', () => select(m.dataset.slug!)));
}

/* ------------------------------------------------------------------
 * 3. How it works: the visual follows the step being read.
 *    Purpose: explanation. Toggles a state; no scrubbing, no pinning.
 * ------------------------------------------------------------------ */
function steps() {
  const section = document.querySelector<HTMLElement>('[data-steps]');
  if (!section) return;
  const visual = section.querySelector<HTMLElement>('[data-steps-visual]');
  section.querySelectorAll<HTMLElement>('[data-step]').forEach((step) => {
    ScrollTrigger.create({
      trigger: step,
      start: 'top 60%',
      end: 'bottom 60%',
      onToggle: (self) => {
        if (!self.isActive) return;
        section.querySelectorAll('[data-step]').forEach((s) => s.classList.toggle('active', s === step));
        if (visual) visual.dataset.state = step.dataset.step;
      },
    });
  });
}

heroIntro();
tailor();
steps();
