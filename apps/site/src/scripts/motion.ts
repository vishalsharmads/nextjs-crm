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

/* ------------------------------------------------------------------
 * 4. The assistant demo: a scripted conversation that plays once.
 *    Purpose: explanation (ask, see the report, confirm a change).
 *    Finished state is the markup default, so no JS or reduced motion
 *    shows the whole conversation. Replay is user-triggered.
 * ------------------------------------------------------------------ */
function assistantDemo() {
  const demo = document.querySelector<HTMLElement>('[data-demo]');
  if (!demo || reduce) return;
  const beat = (k: string) => demo.querySelector<HTMLElement>(`[data-beat="${k}"]`)!;
  const beats = [...demo.querySelectorAll<HTMLElement>('[data-beat]')];
  const bars = [...demo.querySelectorAll<HTMLElement>('[data-bar]')];
  const actions = demo.querySelector<HTMLElement>('[data-actions]')!;
  const confirm = demo.querySelector<HTMLElement>('[data-confirm]')!;
  const done = demo.querySelector<HTMLElement>('[data-done]')!;
  const replay = demo.querySelector<HTMLButtonElement>('[data-replay]')!;
  const typed = [...demo.querySelectorAll<HTMLElement>('[data-type]')].map((el) => ({
    el,
    text: el.textContent ?? '',
  }));

  const typeOn = (tl: gsap.core.Timeline, i: number, at: string | number) => {
    const t = typed[i]!;
    const state = { n: 0 };
    tl.to(
      state,
      {
        n: t.text.length,
        duration: t.text.length * 0.028,
        ease: 'none',
        onUpdate: () => {
          t.el.textContent = t.text.slice(0, Math.round(state.n));
        },
      },
      at,
    );
  };

  const reset = () => {
    gsap.set(beats, { opacity: 0, y: 8 });
    gsap.set(bars, { scaleY: 0.02 });
    gsap.set(actions, { display: 'flex', opacity: 1 });
    gsap.set(done, { display: 'none', opacity: 0 });
    gsap.set(confirm, { scale: 1 });
    typed.forEach((t) => (t.el.textContent = ''));
  };

  const play = () => {
    reset();
    replay.hidden = true;
    const enter = { opacity: 1, y: 0, duration: 0.32, ease: 'power3.out' };
    const tl = gsap.timeline({ onComplete: () => (replay.hidden = false) });
    tl.to(beat('q1'), enter, 0.2);
    typeOn(tl, 0, 0.2);
    tl.to(beat('s1'), enter, '+=0.35')
      .to(beat('a1'), enter, '+=0.45')
      .to(bars, { scaleY: 1, duration: 0.7, ease: 'power3.out', stagger: 0.07 }, '<0.1')
      .to(beat('q2'), enter, '+=1.1');
    typeOn(tl, 1, '<');
    tl.to(beat('c1'), enter, '+=0.4')
      // the person presses Confirm: press feedback, then the result replaces the buttons
      .to(confirm, { scale: 0.95, duration: 0.12, ease: 'power2.out' }, '+=1.3')
      .to(confirm, { scale: 1, duration: 0.16, ease: 'power2.out' })
      .to(actions, { opacity: 0, duration: 0.14 })
      .set(actions, { display: 'none' })
      .set(done, { display: 'flex' })
      .to(done, { opacity: 1, duration: 0.24, ease: 'power3.out' });
  };

  reset();
  ScrollTrigger.create({ trigger: demo, start: 'top 70%', once: true, onEnter: play });
  replay.addEventListener('click', play);
}

/* ------------------------------------------------------------------
 * 5. Product screenshots: tabs swap the view; figures settle in once.
 *    Purpose: explanation (tabs, user-triggered) and preventing a
 *    jarring pop-in (reveal). Reduced motion: instant swap, no reveal.
 * ------------------------------------------------------------------ */
function shots() {
  document.querySelectorAll<HTMLElement>('[data-shots]').forEach((fig) => {
    const tabs = [...fig.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const imgs = [...fig.querySelectorAll<HTMLElement>('[data-shot]')];
    const list = fig.querySelector<HTMLElement>('[role="tablist"]');
    if (list && tabs.length > 1) list.hidden = false;
    const show = (i: number) => {
      tabs.forEach((t, n) => {
        t.setAttribute('aria-selected', String(n === i));
        t.tabIndex = n === i ? 0 : -1;
      });
      imgs.forEach((img, n) => img.classList.toggle('on', n === i));
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => show(i));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const next = (i + d + tabs.length) % tabs.length;
        show(next);
        tabs[next]!.focus();
      });
    });
    if (reduce) return;
    gsap.from(fig.querySelector('.frame'), {
      opacity: 0,
      y: 24,
      duration: 0.7,
      ease: 'power3.out',
      scrollTrigger: { trigger: fig, start: 'top 85%', once: true },
    });
  });
}

heroIntro();
tailor();
steps();
assistantDemo();
shots();
