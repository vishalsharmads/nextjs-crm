import { z } from 'zod';

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const hex = z.string().regex(HEX_RE, 'Use a 6-digit hex color');

export const paletteSchema = z.object({
  primary: hex,
  secondary: hex,
  accent: hex,
  canvas: hex,
  surface: hex,
  ink: hex,
  line: hex,
});
export type Palette = z.infer<typeof paletteSchema>;

export const FONT_FAMILIES = [
  'IBM Plex Sans',
  'Public Sans',
  'Source Sans 3',
  'Atkinson Hyperlegible',
  'system-ui',
] as const;

export const brandingSchema = z.object({
  appName: z.string().trim().min(1).max(60),
  tagline: z.string().trim().max(140).default(''),
  colors: z.object({ light: paletteSchema, dark: paletteSchema }),
  fontFamily: z.enum(FONT_FAMILIES),
  radius: z.number().int().min(0).max(16),
  loginTitle: z.string().trim().max(80).default(''),
  loginTagline: z.string().trim().max(200).default(''),
  footerText: z.string().trim().max(200).default(''),
  pdfHeader: z.string().trim().max(200).default(''),
  emailFromName: z.string().trim().max(80).default(''),
  emailFromAddress: z.union([z.email(), z.literal('')]).default(''),
});
export type Branding = z.infer<typeof brandingSchema>;

export const BRANDING_ASSET_SLOTS = ['logoLight', 'logoDark', 'favicon', 'loginBackground'] as const;
export type BrandingAssetSlot = (typeof BRANDING_ASSET_SLOTS)[number];

/** Public branding payload served unauthenticated at app boot. */
export interface PublicBranding extends Omit<Branding, 'emailFromAddress' | 'emailFromName'> {
  assets: Partial<Record<BrandingAssetSlot, string>>;
  locale: string;
  installed: boolean;
  /** Demo instances only (`DEMO_MODE=true` + `demo:seed`): accounts shown on the sign-in screen. Empty otherwise. */
  demoAccounts: { label: string; email: string; password: string }[];
}

/** Neutral factory theme. Every instance overrides it from settings. */
export const DEFAULT_BRANDING: Branding = {
  appName: 'CRM',
  tagline: '',
  colors: {
    light: {
      primary: '#1F6F5C',
      secondary: '#3B4A63',
      accent: '#C2410C',
      canvas: '#F3F5F4',
      surface: '#FFFFFF',
      ink: '#17201D',
      line: '#DCE3E0',
    },
    dark: {
      primary: '#4FB89C',
      secondary: '#9AA9C2',
      accent: '#F08A5D',
      canvas: '#141917',
      surface: '#1C2220',
      ink: '#E6ECE9',
      line: '#2C3532',
    },
  },
  fontFamily: 'IBM Plex Sans',
  radius: 8,
  loginTitle: '',
  loginTagline: '',
  footerText: '',
  pdfHeader: '',
  emailFromName: '',
  emailFromAddress: '',
};

// ---------- WCAG contrast ----------

function channel(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hexColor: string): number {
  const h = hexColor.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick black or white text for a background, whichever contrasts more. */
export function readableForeground(bg: string): '#FFFFFF' | '#000000' {
  return contrastRatio(bg, '#FFFFFF') >= contrastRatio(bg, '#000000') ? '#FFFFFF' : '#000000';
}

export interface ContrastWarning {
  mode: 'light' | 'dark';
  pair: string;
  ratio: number;
  required: number;
}

/** Check the color pairs the UI actually renders. Text needs 4.5:1, UI components 3:1. */
export function checkPaletteContrast(colors: Branding['colors']): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const p = colors[mode];
    const checks: [string, string, string, number][] = [
      ['ink on surface', p.ink, p.surface, 4.5],
      ['ink on canvas', p.ink, p.canvas, 4.5],
      ['primary on surface', p.primary, p.surface, 3],
      ['accent on surface', p.accent, p.surface, 3],
      ['button text on primary', readableForeground(p.primary), p.primary, 4.5],
    ];
    for (const [pair, fg, bg, required] of checks) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < required) warnings.push({ mode, pair, ratio: Math.round(ratio * 100) / 100, required });
    }
  }
  return warnings;
}
