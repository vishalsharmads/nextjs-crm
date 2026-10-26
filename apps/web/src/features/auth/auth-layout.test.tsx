import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_BRANDING, type PublicBranding } from '@app/shared';
import { AuthLayout } from './auth-layout';

let branding: PublicBranding;
vi.mock('@/app/branding', () => ({ useBranding: () => ({ branding, mode: 'light' }) }));

const make = (p: Partial<PublicBranding> = {}): PublicBranding => ({
  ...DEFAULT_BRANDING,
  assets: {},
  locale: 'en',
  installed: true,
  demoAccounts: [],
  loginNotice: '',
  ...p,
});

function show() {
  render(
    <AuthLayout title="Sign in" description="Welcome back">
      <form aria-label="sign in form" />
    </AuthLayout>,
  );
}

describe('auth layout', () => {
  afterEach(cleanup);

  it('shows the login title and tagline from branding, with the form', () => {
    branding = make({
      appName: 'Harbourline',
      loginTitle: 'Every listing, one place',
      loginTagline: 'Sign in to start',
    });
    show();
    expect(screen.getAllByText('Every listing, one place').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sign in to start').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Harbourline').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'sign in form' })).toBeInTheDocument();
  });

  it('does not repeat the app name when it is also the headline and there is no logo', () => {
    branding = make({ appName: 'Harbourline' });
    show();
    // Once in the wide panel and once in the small-screen band, never as a separate wordmark too.
    expect(screen.getAllByText('Harbourline')).toHaveLength(2);
  });

  it('uses the logo made for the panel background', () => {
    // Factory primary is dark, so the panel wants the dark-background logo.
    branding = make({ appName: 'Harbourline', assets: { logoLight: '/light.png', logoDark: '/dark.png' } });
    show();
    const logos = screen.getAllByRole('img', { name: 'Harbourline' });
    expect(logos.every((img) => img.getAttribute('src') === '/dark.png')).toBe(true);
  });

  it('shows the footer text only when set', () => {
    branding = make({ footerText: 'Support: help@example.test' });
    show();
    expect(screen.getByText('Support: help@example.test')).toBeInTheDocument();
  });
});
