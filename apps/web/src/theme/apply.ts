import { readableForeground, type Palette, type PublicBranding } from '@app/shared';

export type ColorMode = 'light' | 'dark' | 'system';

const FONT_LOADERS: Record<string, () => Promise<unknown>> = {
  'IBM Plex Sans': () =>
    Promise.all([
      import('@fontsource/ibm-plex-sans/400.css'),
      import('@fontsource/ibm-plex-sans/500.css'),
      import('@fontsource/ibm-plex-sans/600.css'),
    ]),
  'Public Sans': () =>
    Promise.all([
      import('@fontsource/public-sans/400.css'),
      import('@fontsource/public-sans/500.css'),
      import('@fontsource/public-sans/600.css'),
    ]),
  'Source Sans 3': () =>
    Promise.all([
      import('@fontsource/source-sans-3/400.css'),
      import('@fontsource/source-sans-3/500.css'),
      import('@fontsource/source-sans-3/600.css'),
    ]),
  'Atkinson Hyperlegible': () =>
    Promise.all([
      import('@fontsource/atkinson-hyperlegible/400.css'),
      import('@fontsource/atkinson-hyperlegible/700.css'),
    ]),
};

export function resolveMode(mode: ColorMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function paletteVars(p: Palette): Record<string, string> {
  return {
    '--canvas': p.canvas,
    '--surface': p.surface,
    '--ink': p.ink,
    '--line': p.line,
    '--primary': p.primary,
    '--primary-fg': readableForeground(p.primary),
    '--secondary': p.secondary,
    '--accent': p.accent,
    '--accent-fg': readableForeground(p.accent),
  };
}

/** Apply branding as CSS variables on :root. No rebuild needed to rebrand. */
export function applyBranding(
  branding: Pick<PublicBranding, 'colors' | 'fontFamily' | 'radius' | 'appName' | 'assets'>,
  mode: ColorMode,
) {
  const root = document.documentElement;
  const resolved = resolveMode(mode);
  root.classList.toggle('dark', resolved === 'dark');
  for (const [k, v] of Object.entries(paletteVars(branding.colors[resolved]))) root.style.setProperty(k, v);
  root.style.setProperty('--radius', `${branding.radius}px`);
  const family = branding.fontFamily === 'system-ui' ? 'system-ui' : `'${branding.fontFamily}'`;
  root.style.setProperty('--font-family', `${family}, system-ui, sans-serif`);
  void FONT_LOADERS[branding.fontFamily]?.();

  setMeta('theme-color', branding.colors[resolved].primary);
  setFavicon(branding.assets.favicon);
}

export function setDocumentTitle(page: string | undefined, appName: string) {
  document.title = page ? `${page} · ${appName}` : appName;
}

function setMeta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

function setFavicon(href: string | undefined) {
  let el = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!href) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('link');
    el.rel = 'icon';
    document.head.appendChild(el);
  }
  el.href = href;
}
