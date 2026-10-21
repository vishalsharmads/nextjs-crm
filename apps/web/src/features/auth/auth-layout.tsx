import type { ReactNode } from 'react';
import { useBranding } from '@/app/branding';

/** Branded sign-in frame: everything visible comes from branding settings. */
export function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { branding } = useBranding();
  const bg = branding.assets.loginBackground;
  const logo = branding.assets.logoLight;
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(420px,520px)]">
      <div
        className="relative hidden flex-col justify-end overflow-hidden bg-primary p-10 text-primary-fg lg:flex"
        style={
          bg
            ? { backgroundImage: `url(${bg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : undefined
        }
      >
        {bg ? <div className="absolute inset-0 bg-overlay" aria-hidden /> : null}
        <div className="relative max-w-md">
          <p className="text-3xl font-semibold tracking-tight">{branding.loginTitle || branding.appName}</p>
          {branding.loginTagline || branding.tagline ? (
            <p className="mt-3 text-base opacity-85">{branding.loginTagline || branding.tagline}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col bg-surface px-6 py-10 sm:px-12">
        <div className="mb-auto">
          {logo ? (
            <img src={logo} alt={branding.appName} className="h-8 max-w-48 object-contain" />
          ) : (
            <span className="text-base font-semibold">{branding.appName}</span>
          )}
        </div>
        <div className="mx-auto w-full max-w-sm py-12">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-sm text-muted">{description}</p> : null}
          <div className="mt-8">{children}</div>
        </div>
        <div className="mt-auto text-xs text-faint">{branding.footerText}</div>
      </div>
    </div>
  );
}
