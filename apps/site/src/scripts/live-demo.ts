import { site } from '../data/site';

/**
 * One demo instance is switched between industries (`npm run demo:reset`). Ask it which industry it shows
 * and turn that industry's demo links into live links; the rest keep pointing at the booking form.
 */
export async function markLiveDemo(): Promise<void> {
  const links = document.querySelectorAll<HTMLAnchorElement>('[data-demo-link]');
  if (!links.length || !site.demoInfoUrl) return;
  let industry: string | undefined;
  try {
    const res = await fetch(site.demoInfoUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    industry = ((await res.json()) as { industry?: string }).industry;
  } catch {
    return; // No demo app next to the site: links stay as built.
  }
  if (!industry) return;
  for (const link of links) {
    if (link.dataset.demoLink !== industry) continue;
    link.href = link.dataset.liveHref ?? site.signInUrl;
    if (link.dataset.liveLabel) link.textContent = link.dataset.liveLabel;
    const badge = link.closest('[data-demo]')?.querySelector<HTMLElement>('.live');
    if (badge) badge.hidden = false;
  }
}
