import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@app/shared';
import { applyBranding, fallbackFavicon } from './apply';
import { labelVars } from '@/lib/labels';
import i18n from '@/i18n';

const branding = { ...DEFAULT_BRANDING, assets: {}, locale: 'en', installed: true };

describe('runtime theming', () => {
  it('applies palette tokens, radius and font as CSS variables', () => {
    applyBranding(
      {
        ...branding,
        radius: 4,
        colors: { ...branding.colors, light: { ...branding.colors.light, primary: '#123456' } },
      },
      'light',
    );
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--primary')).toBe('#123456');
    expect(style.getPropertyValue('--primary-fg')).toBe('#FFFFFF');
    expect(style.getPropertyValue('--radius')).toBe('4px');
    expect(style.getPropertyValue('--font-family')).toContain('IBM Plex Sans');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('switches to the dark palette in dark mode', () => {
    applyBranding(branding, 'dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe(branding.colors.dark.canvas);
  });

  it('picks dark text on light brand colors', () => {
    applyBranding(
      {
        ...branding,
        colors: { ...branding.colors, light: { ...branding.colors.light, primary: '#F5D90A' } },
      },
      'light',
    );
    expect(document.documentElement.style.getPropertyValue('--primary-fg')).toBe('#000000');
  });
});

describe('vocabulary', () => {
  it('interpolates entity labels into copy', () => {
    const vars = labelVars({
      contact: { singular: 'Member', plural: 'Members' },
      lead: { singular: 'Enquiry', plural: 'Enquiries' },
    });
    expect(vars.contactPlural).toBe('Members');
    expect(vars.leadPluralLower).toBe('enquiries');
    expect(i18n.t('settings.leadsToggle', vars)).toBe('Use enquiries');
    expect(i18n.t('settings.lifecycleHelp', vars)).toContain('member');
  });
});

describe('favicon', () => {
  const svgOf = (url: string) => decodeURIComponent(url.replace('data:image/svg+xml,', ''));

  it('falls back to the app initial on the primary color when no favicon is uploaded', () => {
    applyBranding({ ...branding, appName: 'northwind', assets: {} }, 'light');
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link).not.toBeNull();
    const svg = svgOf(link!.href);
    expect(svg).toContain(`fill="${branding.colors.light.primary}"`);
    expect(svg).toContain('>N</text>');
  });

  it('uses the uploaded favicon when there is one', () => {
    applyBranding({ ...branding, assets: { favicon: '/files/fav.png' } }, 'light');
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.getAttribute('href')).toBe(
      '/files/fav.png',
    );
  });

  it('keeps markup characters in the app name out of the svg', () => {
    expect(svgOf(fallbackFavicon('#123456', '<b>Co'))).toContain('>B</text>');
    expect(svgOf(fallbackFavicon('#123456', '&Co'))).toContain('>C</text>');
    expect(svgOf(fallbackFavicon('#123456', ''))).toContain('>?</text>');
  });

  it('writes dark text on a light primary color', () => {
    expect(svgOf(fallbackFavicon('#F5D90A', 'CRM'))).toContain('fill="#000000"');
  });
});
