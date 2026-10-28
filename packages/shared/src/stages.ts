import { z } from 'zod';

/**
 * Pipeline stage colors are named keys, not free colors, so every stage stays legible in light and dark mode
 * and nobody can store a value the theme cannot render. The web app turns each key into `--stage-<key>`.
 */
export const STAGE_COLORS = [
  'gray',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
  'violet',
] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

export const stageColorSchema = z.enum(STAGE_COLORS);

/** Solid stage colors per mode. Each clears 3:1 against the factory surface of its mode (UI component contrast). */
export const STAGE_PALETTE: Record<'light' | 'dark', Record<StageColor, string>> = {
  light: {
    gray: '#6B7280',
    blue: '#2563EB',
    teal: '#0F766E',
    green: '#15803D',
    amber: '#B45309',
    orange: '#C2410C',
    red: '#DC2626',
    pink: '#DB2777',
    violet: '#7C3AED',
  },
  dark: {
    gray: '#9CA3AF',
    blue: '#60A5FA',
    teal: '#2DD4BF',
    green: '#4ADE80',
    amber: '#FBBF24',
    orange: '#FB923C',
    red: '#F87171',
    pink: '#F472B6',
    violet: '#A78BFA',
  },
};

/** The color a stage renders with: stored keys pass through, empty or unknown values fall back to gray. */
export function stageColor(value: string | null | undefined): StageColor {
  return (STAGE_COLORS as readonly string[]).includes(value ?? '') ? (value as StageColor) : 'gray';
}
