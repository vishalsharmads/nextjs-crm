/* global document, matchMedia */
// Hide the hero's animated parts only when motion will run; release them after 3 s regardless.
// Loaded as a blocking file in <head> (not inline) so it runs before first paint under a strict CSP.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion');
  setTimeout(() => document.documentElement.classList.add('motion-ready'), 3000);
}
